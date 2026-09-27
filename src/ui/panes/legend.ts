// src/ui/panes/legend.ts
//
// The legend chart type: for each drawn line, its subject and beneath it the
// full path (Case, kind, quantity, qualifiers), with its summary statistics,
// for a reader who cannot tell lines apart by colour. The table is rebuilt
// only when what it shows changes.

import { contextLabel, subjectLabel } from '../../series/label';
import { formatNumber } from '../chart-format';
import type { PaneAdapter, PaneHost } from './adapter';

export function createLegendAdapter(host: PaneHost): PaneAdapter {
  const { legendHost } = host;

  return {
    surface: 'legend',
    controls: () => [],
    draw({ drawable }) {
      const signature = drawable
        .map(
          (s) =>
            `${s.detail ?? s.name}|${s.color}|${s.stats.mean}|${s.stats.sd}|${s.weightColumn ?? ''}`,
        )
        .join(',');
      if (legendHost.dataset.signature === signature) return;
      legendHost.dataset.signature = signature;
      legendHost.replaceChildren();

      const table = document.createElement('table');
      table.className = 'pane-legend-table';

      const thead = document.createElement('thead');
      const headerRow = document.createElement('tr');
      for (const col of ['Series', 'Mean', '± SD', 'Min', 'Max', 'Unit']) {
        const th = document.createElement('th');
        th.textContent = col;
        headerRow.appendChild(th);
      }
      thead.appendChild(headerRow);
      table.appendChild(thead);

      const tbody = document.createElement('tbody');
      for (const s of drawable) {
        const tr = document.createElement('tr');
        tr.title = s.detail ?? s.name;

        const nameTd = document.createElement('td');
        nameTd.className = 'pane-legend-name';
        const swatch = document.createElement('span');
        swatch.className = 'pane-legend-swatch';
        swatch.style.background = s.color;

        // Without facets, fall back to the two strings the series has.
        const ident = document.createElement('span');
        ident.className = 'pane-legend-ident';
        const nameSpan = document.createElement('span');
        nameSpan.className = 'pane-legend-label';
        nameSpan.textContent = s.facets ? subjectLabel(s.facets) : s.name;
        ident.appendChild(nameSpan);

        const context = s.facets
          ? contextLabel(s.facets)
          : s.detail && s.detail !== s.name
            ? s.detail
            : '';
        // A weighted series' Mean is a mean of means, which the figure alone
        // cannot show, so name the weight.
        const line = s.weightColumn
          ? [context, `weighted mean by ${s.weightColumn}`].filter(Boolean).join(' · ')
          : context;
        if (line) {
          const contextSpan = document.createElement('span');
          contextSpan.className = 'pane-legend-context';
          contextSpan.textContent = line;
          contextSpan.title = line;
          ident.appendChild(contextSpan);
        }
        nameTd.append(swatch, ident);
        tr.appendChild(nameTd);

        for (const value of [s.stats.mean, s.stats.sd, s.stats.min, s.stats.max]) {
          const td = document.createElement('td');
          td.className = 'pane-legend-num';
          td.textContent = s.n > 0 ? formatNumber(value) : '—';
          tr.appendChild(td);
        }

        const unitTd = document.createElement('td');
        unitTd.className = 'pane-legend-unit';
        unitTd.textContent = s.unit;
        tr.appendChild(unitTd);

        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      legendHost.appendChild(table);
    },
    // The table is kept, hidden, so coming back to an unchanged selection
    // costs nothing.
    leave() {},
    resize() {},
  };
}
