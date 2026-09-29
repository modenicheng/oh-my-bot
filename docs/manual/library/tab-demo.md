---
title: 多语言代码 Tab 示例
audience: coder
---

# 多语言代码 Tab 示例

本页验证手册阅读器的多语言 tab 语法：同一段逻辑的多语言实现折叠为一组 tab，读者按语言切换。

## 语法

连续的同缩进代码块序列，首个块的语言标注含 `|` 分隔即视为 tab 组头。组头内容是占位说明，后续连续代码块按各自 info 语言名归组为 tab：

````md
```ts|py|java
三个语言实现如下。
```
```ts
// 第一个 tab：TS
```
```py
# 第二个 tab：PY
```
```java
// 第三个 tab：JAVA
```
````

## 实际渲染效果

同一份「冲向最近 Core」逻辑的三种语言：

```ts|py|java
三种语言实现如下，点击上方 tab 切换。
```
```ts
export function tick(ctx: BotContext) {
  const core = ctx.api.nearestCore()
  if (core) ctx.api.moveTo(core)
}
```
```py
def tick(ctx):
    core = ctx.api.nearest_core()
    if core:
        ctx.api.move_to(core)
```
```java
void tick(Context ctx) {
    Core core = ctx.api.nearestCore();
    if (core != null) ctx.api.moveTo(core);
}
```

## 向后兼容

无 `|` 的常规代码块照常渲染，右上角显示语言标签：

```ts
const answer: number = 42
```

```
无语言标注的裸块不显示标签。
```

组头声明的语言数与后续块数一致时效果最佳；不一致时按实际块数渲染 tab（组头的语言列表仅作人类可读声明，tab 头取各块自己的 info）。
