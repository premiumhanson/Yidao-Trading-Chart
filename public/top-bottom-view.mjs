import { entryWindows, topBottomDrawings } from './top-bottom.mjs';

const colors = { 1: '#f23645', '-1': '#4caf50' };
const badges = { 1: '#e92929e6', '-1': '#20ca26e6' };
const font = '"Microsoft YaHei UI", sans-serif';
const formatRatio = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 });

export function attachTopBottomView(pane) {
  const table = document.createElement('div');
  table.className = 'entry-windows';
  table.hidden = true;
  pane.widget.append(table);
  let requestUpdate;
  let shapes = topBottomDrawings();
  let visibleHits = [];
  let lastRows = '';
  const price = value => value.toFixed(pane.digits);
  const screen = () => {
    const scale = pane.chart.timeScale();
    const first = scale.timeToIndex(pane.bars[0]?.time);
    const lastTime = pane.appliedPreview?.time ?? pane.bars.at(-1)?.time;
    const last = scale.timeToIndex(lastTime);
    if (first === null || last === null) return;
    return {
      at: index => scale.logicalToCoordinate(first + index),
      right: scale.logicalToCoordinate(last + 1),
      y: value => pane.series.priceToCoordinate(value),
    };
  };

  function drawZones(target) {
    target.useMediaCoordinateSpace(({ context, mediaSize: { width, height } }) => {
      if (!shapes.boxes.length) return;
      const coords = screen();
      if (!coords) return;
      context.save();
      context.font = `9px ${font}`;
      context.lineWidth = 1;
      for (const box of shapes.boxes) {
        const start = coords.at(box.from);
        const end = box.kind === 'higher' ? width : box.to === undefined ? coords.right : coords.at(box.to);
        const y1 = coords.y(box.upper);
        const y2 = coords.y(box.lower);
        if (start === null || end === null || end < 0 || start > width ||
          y1 === null || y2 === null || y1 > height || y2 < 0) continue;
        const color = colors[box.direction];
        const confirmed = box.kind === 'confirmed';
        const projected = box.kind === 'higher';
        const left = Math.max(-12, start);
        const right = Math.min(width + 12, end);
        const top = Math.max(-12, y1);
        const bottom = Math.min(height + 12, y2);
        context.fillStyle = color + (confirmed ? '33' : projected ? '12' : '0d');
        context.strokeStyle = color + (projected ? '99' : '80');
        context.setLineDash(confirmed ? [] : [6, 5]);
        context.fillRect(left, top, right - left, bottom - top);
        context.strokeRect(left + 0.5, top + 0.5, right - left, bottom - top);
        if (!box.name || right - left <= context.measureText(box.name).width + 6) continue;
        context.fillStyle = projected ? color + 'cc' : '#d1d4dc';
        context.textAlign = projected ? 'left' : 'right';
        context.textBaseline = 'middle';
        context.fillText(box.name, projected ? Math.max(0, start) + 4 : right - 4,
          projected ? top + 8 : (y1 + y2) / 2);
      }
      context.restore();
    });
  }

  function tooltip(label) {
    const matched = label.matched ? `\n4H 过滤 ✅ 4H 区 ${price(label.matched.lower)} ~ ${price(label.matched.upper)}` : '';
    return [
      `${label.name} · 端点 ${label.count}`, `端点 1: ${price(label.anchorValue)}`,
      `区域: ${price(label.lower)} ~ ${price(label.upper)}`, `动能堆积: ${label.ratio.toFixed(2)}% < 33%`,
      `端点止损 ${price(label.labelStop)} (本端点 ${price(label.endpoint)} ± 厚度 ${price(label.thickness)})`,
      `最远止损 ${price(label.stop)} (锚点 ${price(label.stopAnchor)} ± 厚度 ${price(label.stopThickness)})${matched}`,
    ].join('\n');
  }

  function drawSignals(target) {
    visibleHits = [];
    target.useMediaCoordinateSpace(({ context, mediaSize: { width, height } }) => {
      if (!shapes.lines.length && !shapes.labels.length) return;
      const coords = screen();
      if (!coords) return;
      context.save();
      context.lineWidth = 2;
      context.setLineDash([9, 9]);
      for (const line of shapes.lines) {
        const from = coords.at(line.from);
        const to = line.to === undefined ? coords.right : coords.at(line.to);
        const y = coords.y(line.value);
        if (from === null || to === null || y === null || to < 0 || from > width || y < 0 || y > height) continue;
        context.strokeStyle = line.endpoint ? '#ffb300' : '#ff232a';
        context.beginPath();
        context.moveTo(from, y);
        context.lineTo(to, y);
        context.stroke();
      }
      context.setLineDash([]);
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      for (const label of shapes.labels) {
        const x = coords.at(label.at);
        const y = coords.y(label.value);
        if (x === null || y === null || x < 0 || x > width || y < -40 || y > height + 40) continue;
        const top = label.direction === 1;
        if (label.mark) {
          context.font = `11px ${font}`;
          context.fillStyle = colors[label.direction];
          context.fillText('①', x, y + (top ? -8 : 8));
          continue;
        }
        const rows = [label.name, top ? '▼ 做空' : '▲ 做多', `止损 ${price(label.labelStop)}`];
        context.font = `600 10px ${font}`;
        const w = Math.ceil(Math.max(...rows.map(row => context.measureText(row).width)) + 12);
        const h = 37;
        const edge = y + (top ? -11 : 11);
        const left = x - w / 2;
        const upper = top ? edge - h : edge;
        context.fillStyle = badges[label.direction];
        context.beginPath();
        context.roundRect(left, upper, w, h, 3);
        context.fill();
        context.beginPath();
        context.moveTo(x - 6, edge);
        context.lineTo(x + 6, edge);
        context.lineTo(x, edge + (top ? 6 : -6));
        context.fill();
        context.fillStyle = '#fff';
        rows.forEach((row, i) => context.fillText(row, x, upper + 8 + 10.5 * i));
        visibleHits.push({ left, upper, w, h, label });
      }
      context.restore();
    });
  }

  const views = [
    { zOrder: () => 'bottom', renderer: () => ({ draw: drawZones }) },
    { zOrder: () => 'top', renderer: () => ({ draw: drawSignals }) },
  ];
  pane.series.attachPrimitive({
    attached({ requestUpdate: update }) { requestUpdate = update; },
    detached() { requestUpdate = undefined; },
    paneViews() { return views; },
    autoscaleInfo(from, to) {
      if (!shapes.labels.length || !pane.bars.length) return null;
      const first = pane.chart.timeScale().timeToIndex(pane.bars[0].time);
      let above = 0;
      let below = 0;
      for (const label of shapes.labels) {
        const at = first + label.at;
        if (label.mark || at < from || at > to) continue;
        if (label.direction === 1) above = 43;
        else below = 43;
      }
      return above || below ? { priceRange: null, margins: { above, below } } : null;
    },
    hitTest(x, y) {
      // The pane tooltip uses the actual plot coordinate space.
      const hit = visibleHits.findLast(item =>
        x >= item.left && x < item.left + item.w && y >= item.upper && y < item.upper + item.h);
      const title = hit ? tooltip(hit.label) : '';
      if (pane.widget.title !== title) pane.widget.title = title;
      return null;
    },
  });
  pane.widget.addEventListener('pointerleave', () => { pane.widget.title = ''; });

  function showWindows(result, preview) {
    const rows = entryWindows(result, preview);
    const signature = JSON.stringify([pane.interval, pane.digits, rows]);
    if (signature === lastRows) return;
    lastRows = signature;
    table.hidden = !rows.length;
    table.replaceChildren(...rows.map(row => {
      const card = document.createElement('div');
      card.className = row.direction === 1 ? 'entry-window short' : 'entry-window long';
      const side = row.direction === 1 ? '🔴' : '🟢';
      const direction = row.direction === 1 ? '做空' : '做多';
      const ratio = formatRatio.format(row.ratio ?? 0);
      const momentum = row.momentumActive ? '动能堆积 ✅ ' : '等待动能堆积 · ';
      const estimated = row.locked ? '' : ' (预估)';
      card.textContent = [
        `⏳ 入场窗口期 ${pane.interval.toUpperCase()}`, `${side} ${row.name} · ${direction} · P${row.period}`,
        `区域 ${price(row.lower)} ~ ${price(row.upper)}`, `${momentum}${ratio}%`,
        `最远止损 ${price(row.stop)}${estimated}`, `标签止损 ${price(row.labelStop)}${estimated}`,
      ].join('\n');
      return card;
    }));
    if (rows.length) table.style.right = `${pane.chart.priceScale('right').width() + 4}px`;
  }
  return {
    set(result) {
      shapes = topBottomDrawings(result);
      showWindows(result, pane.appliedPreview);
      requestUpdate?.();
    },
    showWindows,
  };
}
