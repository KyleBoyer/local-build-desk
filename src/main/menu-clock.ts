import { createRequire } from "node:module";
import { join } from "node:path";

export interface MenuClockRow {
  path: number[];
  prefix: string;
  since?: number;
}
export interface MenuClock {
  update(rows: MenuClockRow[]): void;
  dispose(): void;
}

export function createMenuClock(): MenuClock {
  const require = createRequire(join(__dirname, "menu-clock-loader.cjs"));
  const native = require(
    join(__dirname, "../native/menu-clock.node"),
  ).create() as { update(json: string): void; dispose(): void };
  let previous = "";
  return {
    update: (rows) => {
      const encoded = JSON.stringify(rows);
      if (encoded === previous) return;
      native.update(encoded);
      previous = encoded;
    },
    dispose: () => native.dispose(),
  };
}
