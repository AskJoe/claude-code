/**
 * First-time welcome modal. Three slides on a single white card; only opens
 * when localStorage doesn't have the `lab.onboarded.v1` flag. Clicking the
 * sample-prompt button on slide 3 dismisses the modal AND drops the prompt
 * into the chat input via the `onSamplePrompt` callback.
 *
 * Mounted in App.tsx Lab component; the parent decides whether to render
 * based on the localStorage flag, so this component just handles the slide
 * progression and the dismiss callback.
 */

import { useState, type ReactNode } from "react";

const STORAGE_KEY = "lab.onboarded.v1";

const SAMPLE_PROMPT =
  "Make a one-page coffee shop landing site with a hero, menu, and contact section.";

type Props = {
  onDismiss: () => void;
  onSamplePrompt: (text: string) => void;
};

export function Welcome({ onDismiss, onSamplePrompt }: Props) {
  const [slide, setSlide] = useState(0);

  const markOnboarded = () => {
    try {
      localStorage.setItem(STORAGE_KEY, "1");
    } catch {}
  };

  const dismiss = () => {
    markOnboarded();
    onDismiss();
  };

  const advance = () => {
    if (slide < 2) {
      setSlide(slide + 1);
    } else {
      dismiss();
    }
  };

  const trySample = () => {
    markOnboarded();
    onSamplePrompt(SAMPLE_PROMPT);
    onDismiss();
  };

  return (
    <div
      className="welcome-backdrop"
      onClick={(e) => {
        // Click outside the card dismisses (same posture as other modals).
        if (e.target === e.currentTarget) dismiss();
      }}
    >
      <div className="welcome-modal" role="dialog" aria-label="Welcome to Cloudwise Lab">
        <div className="welcome-slide">
          {slide === 0 && (
            <SlideOne />
          )}
          {slide === 1 && (
            <SlideTwo />
          )}
          {slide === 2 && (
            <SlideThree
              prompt={SAMPLE_PROMPT}
              onTry={trySample}
            />
          )}
        </div>

        <div className="welcome-footer">
          <div className="welcome-dots" aria-hidden>
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className={`welcome-dot ${i === slide ? "active" : ""}`}
              />
            ))}
          </div>
          <div className="welcome-actions">
            <button
              type="button"
              className="welcome-skip"
              onClick={dismiss}
            >
              Skip
            </button>
            {slide < 2 ? (
              <button
                type="button"
                className="welcome-cta"
                onClick={advance}
                autoFocus
              >
                Next
                <span className="welcome-cta-shortcut" aria-hidden> ⌘→</span>
              </button>
            ) : (
              <button
                type="button"
                className="welcome-cta"
                onClick={dismiss}
              >
                Got it
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function SlideOne(): ReactNode {
  return (
    <>
      <h2 className="welcome-headline">Welcome to Cloudwise Lab</h2>
      <p className="welcome-body">
        This is your AI-powered website builder. Chat with the agent and watch
        your site come to life on the right.
      </p>
    </>
  );
}

function SlideTwo(): ReactNode {
  return (
    <>
      <h2 className="welcome-headline">How it works</h2>
      <ul className="welcome-list">
        <li>Type what you want</li>
        <li>Agent edits the files for you</li>
        <li>Preview updates instantly</li>
      </ul>
    </>
  );
}

function SlideThree({
  prompt,
  onTry,
}: {
  prompt: string;
  onTry: () => void;
}): ReactNode {
  return (
    <>
      <h2 className="welcome-headline">Try this first</h2>
      <p className="welcome-body">
        Click below to drop this prompt into the chat — you can edit it before
        sending.
      </p>
      <button
        type="button"
        className="welcome-sample"
        onClick={onTry}
      >
        <span className="welcome-sample-text">{prompt}</span>
        <span className="welcome-sample-arrow" aria-hidden>→</span>
      </button>
    </>
  );
}

/** Helper for parent to decide whether to mount Welcome at all. */
export function shouldShowWelcome(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === null;
  } catch {
    return false;
  }
}
