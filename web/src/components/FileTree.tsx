import type { FileNode } from "../../../shared/events.ts";

type Props = {
  files: FileNode[];
  selectedPath: string | null;
  onSelect: (node: FileNode) => void;
};

export function FileTree({ files, selectedPath, onSelect }: Props) {
  return (
    <div className="filetree">
      <div className="filetree-header">Files</div>
      <div className="filetree-body">
        {files.length === 0 ? (
          <div className="filetree-empty">empty — agent hasn't written anything yet</div>
        ) : (
          <Branch nodes={files} depth={0} selectedPath={selectedPath} onSelect={onSelect} />
        )}
      </div>
    </div>
  );
}

function Branch({
  nodes,
  depth,
  selectedPath,
  onSelect,
}: {
  nodes: FileNode[];
  depth: number;
  selectedPath: string | null;
  onSelect: (node: FileNode) => void;
}) {
  return (
    <ul className="filetree-list">
      {nodes.map((node) => {
        const isSelected = node.path === selectedPath;
        const previewable = node.type === "file" && isPreviewable(node.name);
        return (
          <li key={node.path}>
            <button
              type="button"
              className={`filetree-item ${node.type} ${isSelected ? "selected" : ""} ${previewable ? "previewable" : ""}`}
              style={{ paddingLeft: 8 + depth * 14 }}
              onClick={() => onSelect(node)}
              disabled={node.type === "file" && !previewable}
              title={node.path}
            >
              <span className="filetree-icon">{node.type === "dir" ? "📁" : "📄"}</span>
              <span className="filetree-name">{node.name}</span>
            </button>
            {node.type === "dir" && node.children && node.children.length > 0 && (
              <Branch
                nodes={node.children}
                depth={depth + 1}
                selectedPath={selectedPath}
                onSelect={onSelect}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

function isPreviewable(name: string): boolean {
  const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
  return [
    ".html", ".htm",
    ".astro",
    ".css",
    ".js", ".mjs", ".ts", ".tsx", ".jsx",
    ".json",
    ".txt", ".md",
    ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp",
    ".astro",
  ].includes(ext);
}
