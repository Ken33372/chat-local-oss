import { create } from 'zustand'

type DebugPanelState = {
  open: boolean
  openPanel: () => void
  closePanel: () => void
}

export const useDebugPanel = create<DebugPanelState>((set) => ({
  open: false,
  openPanel: () => set({ open: true }),
  closePanel: () => set({ open: false }),
}))
