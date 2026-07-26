import { describe, it, expect } from "vitest";
import {
  normalizePath,
  stripTrailingSep,
  basename,
  dirname,
  joinPaths,
  extname,
  resolveRelative,
  relativePath,
} from "./path";

describe("utils/path", () => {
  describe("normalizePath", () => {
    it("将 Windows 反斜杠转为正斜杠", () => {
      expect(normalizePath("C:\\docs\\file.md")).toBe("C:/docs/file.md");
    });
    it("无反斜杠时原样返回", () => {
      expect(normalizePath("C:/docs/file.md")).toBe("C:/docs/file.md");
    });
  });

  describe("stripTrailingSep", () => {
    it("去除末尾正斜杠", () => {
      expect(stripTrailingSep("C:/docs/")).toBe("C:/docs");
    });
    it("去除末尾反斜杠", () => {
      expect(stripTrailingSep("C:\\docs\\")).toBe("C:\\docs");
    });
    it("无末尾分隔符时原样返回", () => {
      expect(stripTrailingSep("C:/docs")).toBe("C:/docs");
    });
  });

  describe("basename", () => {
    it("Windows 路径", () => {
      expect(basename("C:\\docs\\file.md")).toBe("file.md");
    });
    it("Unix 路径", () => {
      expect(basename("/home/user/file.md")).toBe("file.md");
    });
    it("无目录的文件名", () => {
      expect(basename("file.md")).toBe("file.md");
    });
    it("目录路径返回最后一级", () => {
      expect(basename("C:\\docs\\sub\\")).toBe("sub");
    });
  });

  describe("dirname", () => {
    it("Windows 路径", () => {
      expect(dirname("C:\\docs\\sub\\file.md")).toBe("C:/docs/sub");
    });
    it("Unix 路径", () => {
      expect(dirname("/home/user/file.md")).toBe("/home/user");
    });
    it("无目录时返回原路径", () => {
      expect(dirname("file.md")).toBe("file.md");
    });
  });

  describe("joinPaths", () => {
    it("拼接多段路径", () => {
      expect(joinPaths("C:/docs", "sub", "file.md")).toBe("C:/docs/sub/file.md");
    });
    it("处理末尾/开头的斜杠", () => {
      expect(joinPaths("C:/docs/", "/sub/", "file.md")).toBe("C:/docs/sub/file.md");
    });
    it("处理 Windows 反斜杠", () => {
      expect(joinPaths("C:\\docs", "sub", "file.md")).toBe("C:/docs/sub/file.md");
    });
    it("忽略空段", () => {
      expect(joinPaths("C:/docs", "", "file.md")).toBe("C:/docs/file.md");
    });
  });

  describe("extname", () => {
    it("返回小写扩展名", () => {
      expect(extname("file.MD")).toBe("md");
    });
    it("无扩展名返回空字符串", () => {
      expect(extname("README")).toBe("");
    });
    it("以点开头的文件名不算扩展名", () => {
      expect(extname(".gitignore")).toBe("");
    });
    it("多个点取最后一个", () => {
      expect(extname("archive.tar.gz")).toBe("gz");
    });
  });

  describe("resolveRelative", () => {
    it("绝对路径直接返回（已规范化）", () => {
      expect(resolveRelative("C:/docs", "C:/other/file.md")).toBe("C:/other/file.md");
    });
    it("Unix 绝对路径直接返回", () => {
      expect(resolveRelative("/home/user", "/etc/config.ini")).toBe("/etc/config.ini");
    });
    it("相对路径以 base 为基准", () => {
      expect(resolveRelative("C:/docs", "file.md")).toBe("C:/docs/file.md");
    });
    it("处理 ../ 上级目录", () => {
      expect(resolveRelative("C:/docs/sub", "../file.md")).toBe("C:/docs/file.md");
    });
    it("处理 ./ 当前目录", () => {
      expect(resolveRelative("C:/docs", "./file.md")).toBe("C:/docs/file.md");
    });
  });

  describe("relativePath", () => {
    it("同目录文件（from 视为文件路径）", () => {
      expect(relativePath("C:/docs/a.md", "C:/docs/b.md")).toBe("b.md");
    });
    it("子目录文件", () => {
      expect(relativePath("C:/docs/a.md", "C:/docs/sub/b.md")).toBe("sub/b.md");
    });
    it("上级目录文件", () => {
      expect(relativePath("C:/docs/sub/a.md", "C:/docs/b.md")).toBe("../b.md");
    });
    it("Windows 反斜杠路径", () => {
      expect(relativePath("C:\\docs\\sub\\a.md", "C:\\docs\\b.md")).toBe("../b.md");
    });
  });
});
