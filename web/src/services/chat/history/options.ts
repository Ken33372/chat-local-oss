/** 导入时可选丢弃体积大的内容；默认全部保留。 */
export type ImportOptions = {
  /** 保留搜索、打开网页、页内查找等工具调用记录 */
  toolRecords: boolean
  /** 保留图片原件 */
  images: boolean
}

export const defaultImportOptions: ImportOptions = { toolRecords: true, images: true }
