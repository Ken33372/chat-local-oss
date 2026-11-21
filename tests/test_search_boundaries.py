"""Offline boundary regressions with config, DNS and socket access isolated."""
from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import socket
import ssl
import sys
import types
import unittest
from unittest.mock import Mock, patch

import httpcore
import httpx

SERVER = Path(__file__).resolve().parents[1] / "server"
_CREATE_CONNECTION = socket.create_connection


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _isolated_modules():
    store = types.ModuleType("setup_store")
    store.load = Mock(return_value={})
    with patch.dict(sys.modules, {"setup_store": store}), patch.dict(os.environ, {}, clear=True):
        with patch.object(Path, "read_text", side_effect=OSError("No .env reads in tests")):
            config = _load("_boundary_config", SERVER / "config.py")
    common = _load("_boundary_common", SERVER / "providers" / "common.py")
    providers = types.ModuleType("providers")
    providers.rerank = types.ModuleType("providers.rerank")
    with patch.dict(sys.modules, {
        "config": config, "providers": providers,
        "providers.common": common, "providers.rerank": providers.rerank,
    }):
        search = _load("_boundary_search", SERVER / "providers" / "search.py")
    return config, search


CONFIG, SEARCH = _isolated_modules()


def dns_answers(*addresses):
    return [
        (socket.AF_INET6 if ":" in address else socket.AF_INET,
         socket.SOCK_STREAM, socket.IPPROTO_TCP, "", (address, 443))
        for address in addresses
    ]


class CountingBody(httpx.SyncByteStream):
    def __init__(self, chunk=b"x" * 65536, count=1000):
        self.chunk = chunk
        self.count = count
        self.reads = 0
        self.closed = False

    def __iter__(self):
        for _ in range(self.count):
            self.reads += 1
            yield self.chunk

    def close(self):
        self.closed = True


class TLSStream(httpcore.MockStream):
    def __init__(self, reply):
        super().__init__([reply])
        self.tls = []
        self.written = bytearray()
        self.closed = False

    def start_tls(self, ssl_context, server_hostname=None, timeout=None):
        self.tls.append((ssl_context, server_hostname))
        return self

    def write(self, buffer, timeout=None):
        self.written.extend(buffer)

    def close(self):
        self.closed = True
        super().close()


def wire_reply(body=b"<title>Public</title><p>Hello world</p>"):
    return b"HTTP/1.1 200 OK\r\nContent-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body


class OfflineTest(unittest.TestCase):
    def setUp(self):
        self.dns = self.enterContext(patch.object(
            socket, "getaddrinfo", side_effect=AssertionError("Real DNS forbidden")
        ))
        self.enterContext(patch.object(
            socket, "create_connection", side_effect=AssertionError("Real connection forbidden")
        ))
        self.enterContext(patch.object(
            socket.socket, "connect", side_effect=AssertionError("Real socket forbidden")
        ))
        self.enterContext(patch.object(
            socket.socket, "connect_ex", side_effect=AssertionError("Real socket forbidden")
        ))

    def mock_http(self, handler):
        def factory():
            return httpx.Client(
                transport=httpx.MockTransport(handler), trust_env=False,
                headers={"Accept-Encoding": "identity"}, follow_redirects=False,
            )
        self.enterContext(patch.object(SEARCH, "_html_client", side_effect=factory))

    def allow_dns(self, *addresses):
        self.dns.side_effect = None
        self.dns.return_value = dns_answers(*addresses)


class DomainConfigTests(OfflineTest):
    def test_env_comma_and_newline_not_characters(self):
        with patch.dict(os.environ, {"SEARCH_ALLOWED_DOMAINS": " A.Example, b.example\n C.Example ,, "}):
            self.assertEqual(CONFIG._domains("SEARCH_ALLOWED_DOMAINS", None),
                             ["a.example", "b.example", "c.example"])

    def test_environment_overrides_file_list_and_tuple(self):
        for saved in (["saved.example"], ("saved.example",)):
            with self.subTest(saved=saved), patch.dict(os.environ, {"SEARCH_ALLOWED_DOMAINS": "ENV.Example"}):
                self.assertEqual(CONFIG._domains("SEARCH_ALLOWED_DOMAINS", saved), ["env.example"])

    def test_blank_environment_falls_back_to_saved_formats(self):
        for saved in ([" A.Example ", "", "B.Example"], ("A.Example", "B.Example"), " A.Example,\nB.Example"):
            with self.subTest(saved=saved), patch.dict(os.environ, {"SEARCH_ALLOWED_DOMAINS": " \n"}):
                self.assertEqual(CONFIG._domains("SEARCH_ALLOWED_DOMAINS", saved), ["a.example", "b.example"])

    def test_missing_and_invalid_values(self):
        with patch.dict(os.environ, {}, clear=True):
            for saved in (None, "", 42, {"a": 1}):
                with self.subTest(saved=saved):
                    self.assertEqual(CONFIG._domains("SEARCH_BLOCKED_DOMAINS", saved), [])

    def test_compute_applies_environment_priority_to_both_rules(self):
        with patch.object(CONFIG, "_saved", {"search": {
            "allowed_domains": ["file.example"], "blocked_domains": ["file-block.example"],
        }}), patch.dict(os.environ, {
            "SEARCH_ALLOWED_DOMAINS": "Env.Example,docs.example",
            "SEARCH_BLOCKED_DOMAINS": "blocked.example\nprivate.example",
        }, clear=True):
            result = CONFIG._compute()
        self.assertEqual(result["SEARCH_ALLOWED_DOMAINS"], ["env.example", "docs.example"])
        self.assertEqual(result["SEARCH_BLOCKED_DOMAINS"], ["blocked.example", "private.example"])


class WebBoundaryTests(OfflineTest):
    def test_normal_https_cleaning_and_character_cap(self):
        def handler(request):
            self.assertEqual(request.headers["accept-encoding"], "identity")
            return httpx.Response(200, stream=httpx.ByteStream(
                "<title>正常网页</title><script>secret</script><p>你好世界 Hello</p>".encode()
            ))
        self.mock_http(handler)
        result = SEARCH._fetch_html("https://www.example.com/article", 4)
        self.assertEqual(result["title"], "正常网页")
        self.assertEqual(result["content"], "你好世界")

    def test_invalid_schemes_and_private_literals_never_request(self):
        handler = Mock(side_effect=AssertionError("Blocked URL reached HTTP"))
        self.mock_http(handler)
        urls = [
            "file:///etc/passwd", "ftp://example.com/a", "data:text/plain,test",
            "http:///missing", "https://user:pass@example.com/",
            "http://127.0.0.1", "http://10.1.2.3", "http://172.16.2.3",
            "http://192.168.1.1", "http://169.254.169.254", "http://100.64.0.1",
            "http://0.0.0.0", "http://224.0.0.1", "http://255.255.255.255",
            "http://[::1]", "http://[::]", "http://[fd00::1]", "http://[fe80::1]",
            "http://[ff02::1]", "http://[fec0::1]", "http://[::ffff:127.0.0.1]",
            "http://[fe80::1%25eth0]", "http://[64:ff9b::7f00:1]",
            "http://[2002:7f00:1::]",
        ]
        for url in urls:
            with self.subTest(url=url), self.assertRaises(SEARCH.ProviderError):
                SEARCH._fetch_html(url, 100)
        handler.assert_not_called()
        self.dns.assert_not_called()

    def test_redirect_to_private_or_non_http_never_followed(self):
        for target in ("http://127.0.0.1/private", "http://[::1]/", "file:///secret", "ftp://example.com"):
            calls = []
            stream = CountingBody()
            def handler(request):
                calls.append(str(request.url))
                return httpx.Response(302, headers={"Location": target}, stream=stream)
            with self.subTest(target=target), patch.object(SEARCH, "_html_client", return_value=httpx.Client(
                transport=httpx.MockTransport(handler), trust_env=False,
            )):
                with self.assertRaises(SEARCH.ProviderError):
                    SEARCH._fetch_html("https://public.example/", 100)
            self.assertEqual(calls, ["https://public.example/"])
            self.assertEqual(stream.reads, 0)
            self.assertTrue(stream.closed)

    def test_relative_and_public_redirects(self):
        calls = []
        def handler(request):
            calls.append(str(request.url))
            if len(calls) == 1:
                return httpx.Response(301, headers={"location": "/next"})
            if len(calls) == 2:
                return httpx.Response(307, headers={"location": "https://other.example/final"})
            return httpx.Response(200, stream=httpx.ByteStream(b"<p>final</p>"))
        self.mock_http(handler)
        self.assertEqual(SEARCH._fetch_html("https://public.example/start", 100)["content"], "final")
        self.assertEqual(calls, ["https://public.example/start", "https://public.example/next", "https://other.example/final"])

    def test_redirect_loop_has_finite_hop_limit(self):
        calls = []
        def handler(request):
            calls.append(request.url)
            return httpx.Response(302, headers={"location": "/again"})
        self.mock_http(handler)
        with self.assertRaisesRegex(SEARCH.ProviderError, "重定向"):
            SEARCH._fetch_html("https://public.example/", 100)
        self.assertEqual(len(calls), SEARCH._HTML_MAX_REDIRECTS + 1)

    def test_oversized_stream_stops_at_byte_limit_and_closes(self):
        body = CountingBody()
        self.mock_http(lambda request: httpx.Response(200, stream=body))
        result = SEARCH._fetch_html("https://public.example/", 123)
        self.assertEqual(result["content"], "x" * 123)
        self.assertEqual(body.reads * len(body.chunk), SEARCH._HTML_MAX_BYTES)
        self.assertLess(body.reads, body.count)
        self.assertTrue(body.closed)

    def test_unexpected_compression_rejected_before_reading(self):
        body = CountingBody()
        self.mock_http(lambda request: httpx.Response(200, headers={"content-encoding": "gzip"}, stream=body))
        with self.assertRaisesRegex(SEARCH.ProviderError, "未压缩"):
            SEARCH._fetch_html("https://public.example/", 100)
        self.assertEqual(body.reads, 0)
        self.assertTrue(body.closed)

    def test_error_status_does_not_read_body(self):
        body = CountingBody()
        self.mock_http(lambda request: httpx.Response(403, stream=body))
        with self.assertRaisesRegex(SEARCH.ProviderError, "403"):
            SEARCH._fetch_html("https://public.example/", 100)
        self.assertEqual(body.reads, 0)
        self.assertTrue(body.closed)

    def test_declared_charset_and_unknown_charset(self):
        for charset, encoded, expected in (("iso-8859-1", b"caf\xe9", "café"), ("not-a-codec", b"hello", "hello")):
            with self.subTest(charset=charset), patch.object(SEARCH, "_html_client", return_value=httpx.Client(
                transport=httpx.MockTransport(lambda request: httpx.Response(
                    200, headers={"content-type": f"text/html; charset={charset}"},
                    stream=httpx.ByteStream(encoded),
                )), trust_env=False,
            )):
                self.assertEqual(SEARCH._fetch_html("https://public.example/", 100)["content"], expected)


class ConnectionBoundaryTests(OfflineTest):
    def test_private_or_mixed_dns_answers_block_before_connect(self):
        for addresses in (("127.0.0.1",), ("10.0.0.1",), ("::1",), ("fd00::1",),
                          ("::ffff:192.168.1.1",), ("93.184.216.34", "192.168.1.1"),
                          ("2606:4700:4700::1111", "fe80::1")):
            with self.subTest(addresses=addresses), patch.object(httpcore.SyncBackend, "connect_tcp") as connect:
                self.allow_dns(*addresses)
                with self.assertRaises(SEARCH.ProviderError):
                    SEARCH._PublicNetworkBackend().connect_tcp("private.example", 443)
                connect.assert_not_called()

    def test_public_ipv4_and_ipv6_connect_using_numeric_addresses(self):
        for address in ("93.184.216.34", "2606:4700:4700::1111"):
            with self.subTest(address=address), patch.object(httpcore.SyncBackend, "connect_tcp", return_value=object()) as connect:
                self.allow_dns(address)
                SEARCH._PublicNetworkBackend().connect_tcp("public.example", 443, timeout=7)
                self.assertEqual(connect.call_args.args, (address, 443))
                self.assertEqual(connect.call_args.kwargs["timeout"], 7)

    def test_full_https_preserves_host_sni_and_certificate_verification(self):
        self.allow_dns("93.184.216.34")
        stream = TLSStream(wire_reply())
        with patch.object(httpcore.SyncBackend, "connect_tcp", return_value=stream) as connect:
            result = SEARCH._fetch_html("https://www.example.com/article", 100)
        self.assertEqual(result["content"], "Hello world")
        connect.assert_called_once()
        self.assertEqual(connect.call_args.args, ("93.184.216.34", 443))
        context, hostname = stream.tls[0]
        self.assertEqual(hostname, "www.example.com")
        self.assertTrue(context.check_hostname)
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        self.assertIn(b"Host: www.example.com\r\n", stream.written)
        self.assertTrue(stream.closed)

    def test_rebinding_cannot_change_the_ip_used_by_connect(self):
        self.dns.side_effect = [dns_answers("93.184.216.34"), dns_answers("127.0.0.1")]
        stream = TLSStream(wire_reply())
        with patch.object(httpcore.SyncBackend, "connect_tcp", return_value=stream) as connect:
            SEARCH._fetch_html("https://rebind.example/", 100)
        self.dns.assert_called_once_with("rebind.example", 443, type=socket.SOCK_STREAM)
        self.assertEqual(connect.call_args.args[0], "93.184.216.34")

    def test_real_backend_passes_only_pinned_ip_to_socket_connect(self):
        # Exercise stdlib create_connection and the real SyncBackend, but replace
        # both DNS and socket construction: no OS socket or network is created.
        resolutions = []
        def resolve(host, port, *args, **kwargs):
            resolutions.append(host)
            if host == "rebind.example":
                return dns_answers("93.184.216.34" if len(resolutions) == 1 else "127.0.0.1")
            self.assertEqual(host, "93.184.216.34")
            return dns_answers(host)
        self.dns.side_effect = resolve
        sock = Mock()
        with patch.object(socket, "create_connection", _CREATE_CONNECTION), patch.object(socket, "socket", return_value=sock):
            stream = SEARCH._PublicNetworkBackend().connect_tcp("rebind.example", 443, timeout=1)
            stream.close()
        self.assertEqual(resolutions, ["rebind.example", "93.184.216.34"])
        sock.connect.assert_called_once_with(("93.184.216.34", 443))
        sock.close.assert_called_once()

    def test_domain_redirect_resolves_private_and_is_blocked(self):
        self.dns.side_effect = [dns_answers("93.184.216.34"), dns_answers("10.0.0.1")]
        stream = TLSStream(b"HTTP/1.1 302 Found\r\nLocation: https://internal.example/\r\nContent-Length: 0\r\n\r\n")
        with patch.object(httpcore.SyncBackend, "connect_tcp", return_value=stream) as connect:
            with self.assertRaises(SEARCH.ProviderError):
                SEARCH._fetch_html("https://public.example/", 100)
        self.assertEqual(self.dns.call_count, 2)
        connect.assert_called_once()
        self.assertTrue(stream.closed)

    def test_unusual_numeric_host_checked_after_system_resolution(self):
        for hostname in ("2130706433", "0x7f000001", "127.1", "localhost"):
            with self.subTest(hostname=hostname), patch.object(httpcore.SyncBackend, "connect_tcp") as connect:
                self.allow_dns("127.0.0.1")
                with self.assertRaises(SEARCH.ProviderError):
                    SEARCH._fetch_html(f"http://{hostname}/", 100)
                connect.assert_not_called()

    def test_public_address_fallback_stays_in_validated_set(self):
        self.allow_dns("93.184.216.34", "2606:4700:4700::1111")
        stream = object()
        with patch.object(httpcore.SyncBackend, "connect_tcp", side_effect=[httpcore.ConnectError("failed"), stream]) as connect:
            self.assertIs(SEARCH._PublicNetworkBackend().connect_tcp("public.example", 443), stream)
        self.assertEqual([call.args[0] for call in connect.call_args_list], ["93.184.216.34", "2606:4700:4700::1111"])

    def test_empty_and_failed_dns_fail_closed(self):
        for answer in ([], socket.gaierror("not found")):
            with self.subTest(answer=answer), patch.object(httpcore.SyncBackend, "connect_tcp") as connect:
                self.dns.side_effect = answer if isinstance(answer, Exception) else None
                self.dns.return_value = answer
                with self.assertRaises(SEARCH.ProviderError):
                    SEARCH._PublicNetworkBackend().connect_tcp("missing.example", 443)
                connect.assert_not_called()

    def test_configured_local_searxng_requests_do_not_use_public_transport(self):
        seen = []
        def handler(request):
            seen.append(str(request.url))
            return httpx.Response(200, json={"results": []})
        with patch.object(SEARCH.config, "SEARCH_BASE_URL", "http://127.0.0.1:8080"), patch.object(
            SEARCH, "client", return_value=httpx.Client(transport=httpx.MockTransport(handler), trust_env=False)
        ), patch.object(SEARCH, "_html_client", side_effect=AssertionError("Service must not use webpage transport")):
            self.assertEqual(SEARCH._searxng_page("test", 1), [])
        self.assertTrue(seen[0].startswith("http://127.0.0.1:8080/search?"))
        self.dns.assert_not_called()


if __name__ == "__main__":
    unittest.main()
