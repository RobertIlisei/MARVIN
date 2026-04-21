"use client";

/**
 * Tiny file-type icon helper for the left-column tree.
 *
 * Returns a 12 px lucide-react icon tinted by file-type family. The
 * goal isn't full VSCode / Seti icon parity — MARVIN's aesthetic is
 * minimal + opinionated, not maximal + colourful. Enough visual
 * differentiation that a `.ts` pops from a `.json` pops from an image
 * at a glance, not "thirty hand-drawn icons per language."
 *
 * Icons are driven by the final extension segment (last ".") with a
 * small alias table (tsx → ts etc.) and a handful of filename-level
 * special cases (Dockerfile, Makefile, tsconfig.json). Unrecognised
 * extensions fall through to a generic file glyph.
 */

import {
  Braces,
  File,
  FileCode,
  FileImage,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
  type LucideIcon,
  Settings,
} from "lucide-react";

export type FileIconFamily =
  | "code"
  | "json"
  | "image"
  | "doc"
  | "config"
  | "style"
  | "script"
  | "generic";

interface IconSpec {
  Icon: LucideIcon;
  family: FileIconFamily;
}

/**
 * Family → colour var. Uses existing theme tokens so the icons track
 * light/dark without another @theme entry. Neutrals (generic, doc,
 * script) use fg-faint so they sit back; accented families (code,
 * json, image, style, config) get distinct tints.
 */
const FAMILY_COLOR: Record<FileIconFamily, string> = {
  code: "var(--color-git-modified)", // blue
  json: "var(--color-warn)", // amber
  image: "var(--color-success)", // green
  doc: "var(--color-fg-faint)", // neutral
  config: "var(--color-fg-faint)", // neutral
  style: "var(--color-git-renamed)", // purple
  script: "var(--color-success)", // green
  generic: "var(--color-fg-faint)", // neutral
};

// Special-case full filenames — some files have no extension but are
// well-known (Dockerfile, Makefile) or have an ambiguous extension
// (tsconfig.json is config, not general JSON).
const BY_FILENAME: Record<string, IconSpec> = {
  Dockerfile: { Icon: Settings, family: "config" },
  Makefile: { Icon: Settings, family: "config" },
  Rakefile: { Icon: Settings, family: "config" },
  Procfile: { Icon: Settings, family: "config" },
  Gemfile: { Icon: Settings, family: "config" },
  ".gitignore": { Icon: Settings, family: "config" },
  ".gitattributes": { Icon: Settings, family: "config" },
  ".npmrc": { Icon: Settings, family: "config" },
  ".env": { Icon: Settings, family: "config" },
  "tsconfig.json": { Icon: Settings, family: "config" },
  "package.json": { Icon: Settings, family: "config" },
  "pnpm-lock.yaml": { Icon: Settings, family: "config" },
  "pnpm-workspace.yaml": { Icon: Settings, family: "config" },
  "biome.json": { Icon: Settings, family: "config" },
  "next.config.ts": { Icon: Settings, family: "config" },
  "turbo.json": { Icon: Settings, family: "config" },
  "vitest.config.ts": { Icon: Settings, family: "config" },
  "Cargo.toml": { Icon: Settings, family: "config" },
  "Cargo.lock": { Icon: Settings, family: "config" },
  LICENSE: { Icon: FileText, family: "doc" },
  "README.md": { Icon: FileText, family: "doc" },
};

// Extension → (Icon, family). Kept deliberately short — add entries
// when a specific extension is common in MARVIN-using projects.
const BY_EXT: Record<string, IconSpec> = {
  // Source code
  ts: { Icon: FileCode, family: "code" },
  tsx: { Icon: FileCode, family: "code" },
  js: { Icon: FileCode, family: "code" },
  jsx: { Icon: FileCode, family: "code" },
  mjs: { Icon: FileCode, family: "code" },
  cjs: { Icon: FileCode, family: "code" },
  py: { Icon: FileCode, family: "code" },
  rs: { Icon: FileCode, family: "code" },
  go: { Icon: FileCode, family: "code" },
  java: { Icon: FileCode, family: "code" },
  kt: { Icon: FileCode, family: "code" },
  c: { Icon: FileCode, family: "code" },
  cc: { Icon: FileCode, family: "code" },
  cpp: { Icon: FileCode, family: "code" },
  h: { Icon: FileCode, family: "code" },
  hpp: { Icon: FileCode, family: "code" },
  rb: { Icon: FileCode, family: "code" },
  php: { Icon: FileCode, family: "code" },
  swift: { Icon: FileCode, family: "code" },
  cs: { Icon: FileCode, family: "code" },
  lua: { Icon: FileCode, family: "code" },
  // Data / config
  json: { Icon: FileJson, family: "json" },
  jsonc: { Icon: FileJson, family: "json" },
  yaml: { Icon: Braces, family: "config" },
  yml: { Icon: Braces, family: "config" },
  toml: { Icon: Braces, family: "config" },
  // Styles
  css: { Icon: FileCode, family: "style" },
  scss: { Icon: FileCode, family: "style" },
  sass: { Icon: FileCode, family: "style" },
  less: { Icon: FileCode, family: "style" },
  // Images
  png: { Icon: FileImage, family: "image" },
  jpg: { Icon: FileImage, family: "image" },
  jpeg: { Icon: FileImage, family: "image" },
  gif: { Icon: FileImage, family: "image" },
  svg: { Icon: FileImage, family: "image" },
  webp: { Icon: FileImage, family: "image" },
  ico: { Icon: FileImage, family: "image" },
  // Shell / scripts
  sh: { Icon: FileCode, family: "script" },
  bash: { Icon: FileCode, family: "script" },
  zsh: { Icon: FileCode, family: "script" },
  // Docs
  md: { Icon: FileText, family: "doc" },
  mdx: { Icon: FileText, family: "doc" },
  txt: { Icon: FileText, family: "doc" },
  rst: { Icon: FileText, family: "doc" },
  // Markup
  html: { Icon: FileCode, family: "code" },
  xml: { Icon: FileCode, family: "code" },
};

function resolve(name: string): IconSpec {
  const byName = BY_FILENAME[name];
  if (byName) return byName;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return { Icon: File, family: "generic" };
  const ext = name.slice(dot + 1).toLowerCase();
  return BY_EXT[ext] ?? { Icon: File, family: "generic" };
}

/**
 * Render a small file-type icon for `filename`. Used in the file
 * tree row; sized at 12 px to match the existing `w-3 text-[10px]`
 * chevron column.
 */
export function FileIcon({
  filename,
  className,
}: {
  filename: string;
  className?: string;
}) {
  const { Icon, family } = resolve(filename);
  return (
    <Icon
      size={12}
      strokeWidth={1.8}
      style={{ color: FAMILY_COLOR[family] }}
      className={`shrink-0 ${className ?? ""}`.trim()}
      aria-hidden="true"
    />
  );
}

/**
 * Directory icon — closed vs open. Neutral fg-faint tint so it sits
 * back compared to the file-type icons (dirs are structure, files
 * are content).
 */
export function DirIcon({ open }: { open: boolean }) {
  const Icon = open ? FolderOpen : Folder;
  return (
    <Icon
      size={12}
      strokeWidth={1.8}
      style={{ color: "var(--color-fg-faint)" }}
      className="shrink-0"
      aria-hidden="true"
    />
  );
}
