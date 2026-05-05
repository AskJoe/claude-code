type Props = {
  on: boolean;
  onToggle: () => void;
};

/**
 * Topbar pill that toggles the click-to-edit overlay in the preview iframe.
 * The overlay's runtime lives at server/preview-editor-runtime.ts; the
 * parent and iframe stay in sync via postMessage.
 */
export function EditModeToggle({ on, onToggle }: Props) {
  return (
    <button
      type="button"
      className={`edit-mode-btn ${on ? "on" : ""}`}
      onClick={onToggle}
      title={on ? "Exit edit mode (⌘E)" : "Click on text in the preview to edit it (⌘E)"}
    >
      <PencilIcon />
      <span>{on ? "Editing" : "Edit"}</span>
    </button>
  );
}

function PencilIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M11 1.5L14.5 5L5 14.5H1.5V11L11 1.5Z" />
    </svg>
  );
}
