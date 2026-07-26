// markdown-it 插件类型声明（部分插件未自带类型）

declare module "markdown-it-emoji" {
  import type MarkdownIt from "markdown-it";
  const bare: MarkdownIt.PluginSimple;
  const light: MarkdownIt.PluginSimple;
  const full: MarkdownIt.PluginSimple;
  export { bare, light, full };
}

declare module "markdown-it-front-matter" {
  import type MarkdownIt from "markdown-it";
  // 注意：cb 在解析到 front-matter 时为必填，缺省会抛 TypeError
  const plugin: (md: MarkdownIt, cb: (fm: string) => void) => void;
  export default plugin;
}

declare module "markdown-it-task-lists" {
  import type MarkdownIt from "markdown-it";
  interface Options {
    enabled?: boolean;
    label?: boolean;
    labelAfter?: boolean;
  }
  const plugin: (md: MarkdownIt, opts?: Options) => void;
  export default plugin;
}

declare module "markdown-it-footnote" {
  import type MarkdownIt from "markdown-it";
  const plugin: MarkdownIt.PluginSimple;
  export default plugin;
}

declare module "markdown-it-sub" {
  import type MarkdownIt from "markdown-it";
  const plugin: MarkdownIt.PluginSimple;
  export default plugin;
}

declare module "markdown-it-sup" {
  import type MarkdownIt from "markdown-it";
  const plugin: MarkdownIt.PluginSimple;
  export default plugin;
}

declare module "markdown-it-ins" {
  import type MarkdownIt from "markdown-it";
  const plugin: MarkdownIt.PluginSimple;
  export default plugin;
}

declare module "markdown-it-mark" {
  import type MarkdownIt from "markdown-it";
  const plugin: MarkdownIt.PluginSimple;
  export default plugin;
}

declare module "markdown-it-abbr" {
  import type MarkdownIt from "markdown-it";
  const plugin: MarkdownIt.PluginSimple;
  export default plugin;
}

declare module "markdown-it-container" {
  import type MarkdownIt from "markdown-it";
  interface ContainerOpts {
    marker?: string;
    validate?(params: string): boolean;
    render?(tokens: any, idx: number): string;
  }
  const plugin: (md: MarkdownIt, name: string, opts?: ContainerOpts) => void;
  export default plugin;
}

declare module "markdown-it-multimd-table" {
  import type MarkdownIt from "markdown-it";
  interface Options {
    multiline?: boolean;
    rowspan?: boolean;
    headerless?: boolean;
    multibody?: boolean;
  }
  const plugin: (md: MarkdownIt, opts?: Options) => void;
  export default plugin;
}

declare module "markdown-it-texmath" {
  import type MarkdownIt from "markdown-it";
  interface Options {
    engine?: { renderToString(expr: string, opts?: any): string };
    delimiters?: "dollars" | "brackets" | "gitlab" | "pandoc" | "raw";
    katexOptions?: any;
  }
  const plugin: (md: MarkdownIt, opts?: Options) => void;
  export default plugin;
}
