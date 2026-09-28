/**
 * 拖放动作规划测试（issue #92）
 *
 * `planDrop` 是纯函数：把 Rust `classify_drop_paths` 的分类结果规划成打开动作。
 * 图片单列到 `images`（issue #288）；应用打不开的文件收进 `unsupportedFiles` 供调用方提示
 * （issue #317）；缺失路径 / 多投时被忽略的目录：既不进 `files`，也不设 `workspace`，且**不**提示。
 */
import { describe, it, expect } from "vitest";
import { planDrop, type DropEntry } from "./dropPlan";

const file = (path: string): DropEntry => ({ path, kind: "file" });
const folder = (path: string): DropEntry => ({ path, kind: "folder" });
const missing = (path: string): DropEntry => ({ path, kind: "missing" });

describe("planDrop", () => {
  it("单个目录 → 作为工作区打开，不打开标签", () => {
    const plan = planDrop([folder("/ws/docs")]);
    expect(plan.workspace).toBe("/ws/docs");
    expect(plan.files).toEqual([]);
    expect(plan.images).toEqual([]);
  });

  it("单个文件 → 打开为标签，不设工作区", () => {
    const plan = planDrop([file("/ws/a.md")]);
    expect(plan.workspace).toBeNull();
    expect(plan.files).toEqual(["/ws/a.md"]);
    expect(plan.images).toEqual([]);
  });

  it("多个文件 → 保持拖入顺序全部打开", () => {
    const plan = planDrop([file("/ws/a.md"), file("/ws/b.md"), file("/ws/c.txt")]);
    expect(plan.files).toEqual(["/ws/a.md", "/ws/b.md", "/ws/c.txt"]);
    expect(plan.workspace).toBeNull();
    expect(plan.images).toEqual([]);
  });

  it("图片单列到 images，不进 files（issue #288）", () => {
    const plan = planDrop([file("/ws/a.md"), file("/ws/pic.png"), file("/ws/photo.JPG")]);
    expect(plan.files).toEqual(["/ws/a.md"]);
    expect(plan.images).toEqual(["/ws/pic.png", "/ws/photo.JPG"]);
    expect(plan.workspace).toBeNull();
  });

  it("只拖入图片 → images 有值，files 为空、不设工作区", () => {
    const plan = planDrop([file("/ws/pic.png"), file("/ws/a.svg")]);
    expect(plan.files).toEqual([]);
    expect(plan.images).toEqual(["/ws/pic.png", "/ws/a.svg"]);
    expect(plan.workspace).toBeNull();
  });

  it("不支持的类型 → 不当标签打开，但收进 unsupportedFiles 供提示（#92 + #317）", () => {
    const plan = planDrop([file("/ws/a.md"), file("/ws/archive.zip"), file("/ws/setup.exe")]);
    expect(plan.files).toEqual(["/ws/a.md"]);
    expect(plan.images).toEqual([]);
    expect(plan.workspace).toBeNull();
    expect(plan.unsupportedFiles).toEqual(["/ws/archive.zip", "/ws/setup.exe"]);
  });

  it("混投里只混进一个打不开的 → unsupportedFiles 只有它（此时提示才带兜底动作）", () => {
    const plan = planDrop([file("/ws/a.md"), file("/ws/pic.png"), file("/ws/manual.pdf")]);
    expect(plan.files).toEqual(["/ws/a.md"]);
    expect(plan.images).toEqual(["/ws/pic.png"]);
    expect(plan.unsupportedFiles).toEqual(["/ws/manual.pdf"]);
  });

  it("可打开的文件与图片都不算 unsupportedFiles", () => {
    const plan = planDrop([file("/ws/a.md"), file("/ws/Makefile"), file("/ws/pic.png")]);
    expect(plan.unsupportedFiles).toEqual([]);
  });

  it("无后缀文件 → 当标签打开（#308：不再按大小拦截）", () => {
    const plan = planDrop([file("/ws/Makefile")]);
    expect(plan.files).toEqual(["/ws/Makefile"]);
    expect(plan.images).toEqual([]);
    expect(plan.workspace).toBeNull();
  });

  it("缺失路径 → 不产生动作（图片也不例外），也不进 unsupportedFiles（不该提示）", () => {
    const plan = planDrop([missing("/ws/gone.md"), missing("/ws/gone.png")]);
    expect(plan.files).toEqual([]);
    expect(plan.images).toEqual([]);
    expect(plan.workspace).toBeNull();
    expect(plan.unsupportedFiles).toEqual([]);
  });

  it("目录与文件混投 → 只打开文件，不设工作区", () => {
    const plan = planDrop([folder("/ws/docs"), file("/ws/a.md")]);
    expect(plan.workspace).toBeNull();
    expect(plan.files).toEqual(["/ws/a.md"]);
    expect(plan.images).toEqual([]);
  });

  it("多个目录 → 不设工作区", () => {
    const plan = planDrop([folder("/ws/a"), folder("/ws/b")]);
    expect(plan.workspace).toBeNull();
    expect(plan.files).toEqual([]);
    expect(plan.images).toEqual([]);
  });

  it("单个目录 + 只有图片 → 仍按工作区处理，图片单列", () => {
    const plan = planDrop([folder("/ws/docs"), file("/ws/pic.png")]);
    expect(plan.workspace).toBe("/ws/docs");
    expect(plan.files).toEqual([]);
    expect(plan.images).toEqual(["/ws/pic.png"]);
  });

  it("多投时被忽略的目录 → 不进 unsupportedFiles（目录是另一件事，见 #318）", () => {
    const plan = planDrop([folder("/ws/a"), folder("/ws/b"), file("/ws/c.md")]);
    expect(plan.workspace).toBeNull();
    expect(plan.files).toEqual(["/ws/c.md"]);
    expect(plan.unsupportedFiles).toEqual([]);
  });

  it("空输入 → 空动作", () => {
    const plan = planDrop([]);
    expect(plan).toEqual({ workspace: null, files: [], images: [], unsupportedFiles: [] });
  });
});
