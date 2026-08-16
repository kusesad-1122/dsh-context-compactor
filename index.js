// Loader 兼容入口：部分 DSH loader 约定直接导入包根目录的 index.js。
// 注意：不能导出 default，否则 loader 的 unwrapExports 会丢掉具名的 inject。
export * from './lib/index.js'
