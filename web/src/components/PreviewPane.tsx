type Props = {
  previewBase: string | null;
  /** Changes to force the iframe to reload (e.g. on each build transition). */
  reloadKey?: number | string;
};

/**
 * The right-pane preview — always loads `index.html`, which the server resolves
 * to `dist/index.html` after the agent runs `npm run build`. If there's no
 * build yet, the server returns a friendly "not built yet" 404 page.
 */
export function PreviewPane({ previewBase, reloadKey = "0" }: Props) {
  if (!previewBase) {
    return <div className="preview-empty">connecting…</div>;
  }
  const src = `${previewBase}index.html`;
  return (
    <iframe
      key={`${src}-${reloadKey}`}
      className="preview-frame"
      src={src}
      sandbox="allow-scripts allow-forms allow-same-origin"
      title="lab preview"
    />
  );
}
