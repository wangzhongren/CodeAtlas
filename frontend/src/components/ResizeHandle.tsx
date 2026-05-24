import { useCallback, useRef } from 'react';

interface Props {
  direction: 'horizontal' | 'vertical';
  onResize: (delta: number) => void;
}

export default function ResizeHandle({ direction, onResize }: Props) {
  const dragging = useRef(false);
  const startPos = useRef(0);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragging.current = true;
      startPos.current = direction === 'horizontal' ? e.clientY : e.clientX;

      const onMouseMove = (ev: MouseEvent) => {
        if (!dragging.current) return;
        const current = direction === 'horizontal' ? ev.clientY : ev.clientX;
        onResize(current - startPos.current);
        startPos.current = current;
      };

      const onMouseUp = () => {
        dragging.current = false;
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    },
    [direction, onResize]
  );

  const isH = direction === 'horizontal';

  return (
    <div
      onMouseDown={onMouseDown}
      className={`shrink-0 transition-colors z-20 ${
        isH
          ? 'h-[5px] w-full cursor-row-resize hover:bg-[#8ab4f8]/30'
          : 'w-[5px] h-full cursor-col-resize hover:bg-[#8ab4f8]/30'
      }`}
      style={{
        background: 'transparent',
        flexShrink: 0,
      }}
    >
      <div
        className={`${isH ? 'h-full w-8 mx-auto' : 'w-full h-8 my-auto'} rounded-full`}
        style={{ background: 'transparent' }}
      />
    </div>
  );
}
