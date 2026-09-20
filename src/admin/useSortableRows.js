import { useEffect, useRef, useState } from 'react';

/** 仅把手拦截触摸；长按开始排序，普通行仍可滚动。 */
export default function useSortableRows({ items, setItems, api, endpoint, onToast, reload, group }) {
  const [activeId, setActiveId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [overId, setOverId] = useState(null);
  const gesture = useRef(null);
  const latest = useRef(items);
  latest.current = items;
  useEffect(() => () => clearTimeout(gesture.current?.timer), []);

  const persist = async (before, next) => {
    if (before.every((row, index) => row.id === next[index]?.id)) return;
    setSaving(true);
    try {
      await api.put(endpoint, { ids: next.map((row) => row.id) });
      onToast('顺序已保存');
    } catch (error) {
      onToast(error.message);
      setItems(before);
      await reload();
    } finally { setSaving(false); }
  };
  const move = (id, targetId) => {
    const rows = [...latest.current];
    const from = rows.findIndex((row) => row.id === id);
    const to = rows.findIndex((row) => row.id === targetId);
    if (from < 0 || to < 0 || from === to) return rows;
    rows.splice(to, 0, rows.splice(from, 1)[0]);
    latest.current = rows;
    setItems(rows);
    return rows;
  };
  const finish = (cancel = false) => {
    const current = gesture.current;
    if (!current) return;
    clearTimeout(current.timer);
    gesture.current = null;
    setActiveId(null);
    setOverId(null);
    if (cancel) { latest.current = current.before; setItems(current.before); }
    else if (current.active) persist(current.before, current.targetId == null ? latest.current : move(current.id, current.targetId));
  };
  const handleProps = (row, label) => ({
    type: 'button', className: 'sort-handle', disabled: saving,
    'aria-label': `排序 ${label}，拖动把手或按上下方向键`,
    'aria-pressed': activeId === row.id,
    title: '拖动把手排序 · ↑↓ 排序',
    onContextMenu: (event) => event.preventDefault(),
    onPointerDown: (event) => {
      if (saving || (event.pointerType === 'mouse' && event.button !== 0)) return;
      const current = { id: row.id, before: [...latest.current], x: event.clientX, y: event.clientY, active: false };
      gesture.current = current;
      event.currentTarget.setPointerCapture(event.pointerId);
      // 桌面鼠标：按下即进入排序。桌面习惯是「按住就拖」，若也要求长按 300ms，
      // 按下后立刻移动会被下面的 9px 判定当成滑动而取消（旧实现就是这样），
      // 表现成「拖了没反应、顺序也存不下来」。长按只对触屏有意义（避免和页面滚动打架）。
      if (event.pointerType === 'mouse') {
        current.active = true;
        setActiveId(row.id);
        return;
      }
      current.timer = setTimeout(() => {
        current.active = true;
        setActiveId(row.id);
        navigator.vibrate?.(20);
      }, 300);
    },
    onPointerMove: (event) => {
      const current = gesture.current;
      if (!current) return;
      if (!current.active) {
        if (Math.hypot(event.clientX - current.x, event.clientY - current.y) > 9) finish(true);
        return;
      }
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-sort-id]');
      if (target?.dataset.sortGroup === group) {
        current.targetId = Number(target.dataset.sortId);
        setOverId(current.targetId);
      }
      if (event.clientY < 85) window.scrollBy(0, -14);
      else if (event.clientY > window.innerHeight - 65) window.scrollBy(0, 14);
    },
    onPointerUp: () => finish(),
    onPointerCancel: () => finish(true),
    onLostPointerCapture: () => { if (gesture.current) finish(true); },
    onKeyDown: (event) => {
      if (!['ArrowUp', 'ArrowDown'].includes(event.key) || saving) return;
      event.preventDefault();
      const before = [...latest.current];
      const index = before.findIndex((item) => item.id === row.id);
      const target = before[index + (event.key === 'ArrowUp' ? -1 : 1)];
      if (target) persist(before, move(row.id, target.id));
    },
  });
  return { handleProps, activeId, overId, saving };
}
