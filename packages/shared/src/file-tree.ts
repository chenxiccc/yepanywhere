/** 文件树节点 / File tree node */
export interface FileNode {
  name: string;
  /** 相对于项目根目录的路径 / Path relative to project root */
  path: string;
  isDirectory: boolean;
  /** 文件大小（仅文件有）/ File size in bytes (files only) */
  size?: number;
  /** ISO 8601 修改时间（仅文件有）/ Last modified time (files only) */
  modifiedAt?: string;
  isSymlink?: boolean;
  symlinkTarget?: string;
}

/** 目录列表响应 / Directory listing response */
export interface FileListResponse {
  children: FileNode[];
}