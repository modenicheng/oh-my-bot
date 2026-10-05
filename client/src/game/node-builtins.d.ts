// 本地 ambient 类型：测试用 node: 内建模块（readFileSync 等），client
// tsconfig 未引入 @types/node（DOM 库足够生产代码）。仅 *.test.ts 需要。
declare module 'node:fs' {
  export function readFileSync(path: URL | string, encoding: 'utf8'): string
}
