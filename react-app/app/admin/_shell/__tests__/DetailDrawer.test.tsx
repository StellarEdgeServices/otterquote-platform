/**
 * Tests for the shared DetailDrawer (D-211 Phase 9 / A6).
 *
 * Covers open/closed visibility and onClose firing on both the backdrop click
 * and the × close-button click. jsdom is the configured default env.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DetailDrawer } from '../DetailDrawer';

describe('DetailDrawer visibility', () => {
  it('renders nothing when open=false', () => {
    const { container } = render(
      <DetailDrawer open={false} title="Hidden" onClose={vi.fn()}>
        <div>body content</div>
      </DetailDrawer>,
    );
    expect(container.firstChild).toBeNull();
    expect(screen.queryByText('body content')).toBeNull();
  });

  it('renders title + children when open=true', () => {
    render(
      <DetailDrawer open title="Visible Title" onClose={vi.fn()}>
        <div>body content</div>
      </DetailDrawer>,
    );
    expect(screen.getByText('Visible Title')).toBeInTheDocument();
    expect(screen.getByText('body content')).toBeInTheDocument();
  });
});

describe('DetailDrawer onClose', () => {
  it('fires onClose when the backdrop is clicked', () => {
    const onClose = vi.fn();
    render(
      <DetailDrawer open title="T" onClose={onClose}>
        <div>x</div>
      </DetailDrawer>,
    );
    fireEvent.click(screen.getByTestId('drawer-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('fires onClose when the × close button is clicked', () => {
    const onClose = vi.fn();
    render(
      <DetailDrawer open title="T" onClose={onClose}>
        <div>x</div>
      </DetailDrawer>,
    );
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not fire onClose when body content is clicked', () => {
    const onClose = vi.fn();
    render(
      <DetailDrawer open title="T" onClose={onClose}>
        <button type="button">inner</button>
      </DetailDrawer>,
    );
    fireEvent.click(screen.getByRole('button', { name: /inner/i }));
    expect(onClose).not.toHaveBeenCalled();
  });
});
