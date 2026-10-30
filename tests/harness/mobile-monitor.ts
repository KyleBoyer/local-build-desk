import { Engine } from "../../src/core/engine";
const state = Engine.prototype.state;
Engine.prototype.state = function () {
  (globalThis as any).__mobileEngine = this;
  return state.call(this);
};
void import("./store-releases");
