'use client';

/**
 * Reusable photo/file uploader (H9). Presentational: the parent owns the photo
 * state, validation, and FileReader previews; this renders the upload zone,
 * thumbnails, a remove affordance, and any per-tier validation errors.
 *
 * Hardening fold-in (brief item 5): thumbnails/previews and error messages are
 * rendered as React JSX/state — never innerHTML. Image files preview as <img>;
 * a Tier-1 PDF previews as a document chip (no <img>).
 */

import { useRef, useState } from 'react';
import type { PhotoTier, SelectedPhoto } from '../types';
import { acceptAttr, tierAcceptsPdf } from '../utils';

interface PhotoUploaderProps {
  tier: PhotoTier;
  emoji?: string;
  primaryText: string;
  hintText?: string;
  photos: SelectedPhoto[];
  errors: string[];
  onFiles: (files: FileList) => void;
  onRemove: (id: string) => void;
}

export function PhotoUploader({
  tier,
  emoji = '📤',
  primaryText,
  hintText,
  photos,
  errors,
  onFiles,
  onRemove,
}: PhotoUploaderProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragover, setDragover] = useState(false);

  return (
    <div className="ri-upload-section">
      <div
        className={'ri-upload-zone' + (dragover ? ' dragover' : '')}
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragover(true);
        }}
        onDragLeave={() => setDragover(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragover(false);
          if (e.dataTransfer?.files?.length) onFiles(e.dataTransfer.files);
        }}
      >
        <span className="ri-up-emoji" aria-hidden="true">
          {emoji}
        </span>
        <p>
          <strong>{primaryText}</strong>
        </p>
        {hintText && <p>{hintText}</p>}
        <input
          ref={inputRef}
          type="file"
          className="ri-file-input"
          accept={acceptAttr(tier)}
          {...(tierAcceptsPdf(tier) ? {} : { capture: 'environment' as const })}
          multiple
          onChange={(e) => {
            if (e.target.files?.length) onFiles(e.target.files);
            // Reset so re-selecting the same file fires change again.
            e.target.value = '';
          }}
        />
      </div>

      {errors.length > 0 && (
        <ul className="ri-errors" role="alert">
          {errors.map((msg, i) => (
            <li key={i}>{msg}</li>
          ))}
        </ul>
      )}

      {photos.length > 0 && (
        <div className="ri-thumbs">
          {photos.map((photo) => (
            <div className="ri-thumb" key={photo.id}>
              {photo.isImage ? (
                <img src={photo.previewUrl ?? undefined} alt={photo.file.name} />
              ) : (
                <span className="ri-doc">
                  <span className="ri-doc-icon" aria-hidden="true">
                    📄
                  </span>
                  {photo.file.name}
                </span>
              )}
              <button
                type="button"
                className="ri-remove"
                aria-label={'Remove ' + photo.file.name}
                onClick={() => onRemove(photo.id)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
