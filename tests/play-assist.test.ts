import { it, expect } from "vitest";
import { JSDOM } from "jsdom";
import { playAssist, type PageTask } from "../src/main/play-assist";

// Play Console's "Create promo code" form, reduced to the structure observed
// in the live Console (Nov 2026): labels not tied to inputs, a purchase option
// dialog behind "+ Product", and a calendar whose days carry data-date.
const form = `
<console-form-row><div class="label-container"><label>Promotion name *</label></div>
  <div class="console-form-row-content"><material-input><label class="mdc-text-field"><input type="text"></label></material-input></div></console-form-row>
<console-form-row><div><label>Start date and time *</label></div>
  <div><material-dropdown-select id="start"><span>Select a date</span></material-dropdown-select></div></console-form-row>
<console-form-row><div><label>End date and time *</label></div>
  <div><material-dropdown-select id="end"><span>Select a date</span></material-dropdown-select></div></console-form-row>
<console-form-row><div><label>Promotion type *</label></div>
  <div><div><input type="radio" name="t"><span>Paid app</span></div>
  <div><input type="radio" name="t" id="otp"><span>One-time product</span></div>
  <span id="chosen"></span><button id="add-product" hidden>+ Product</button>
  <div><input type="radio" name="t"><span>Subscription</span></div></div></console-form-row>
<console-form-row><div><label>Number of codes *</label></div><div><input type="text" aria-label="Number of codes"></div></console-form-row>
<focus-trap id="dialog" hidden><h2>Select an active purchase option</h2>
  <input aria-label="Search by product name or ID">
  <div class="particle-table-row">Gems com.app.gems</div>
  <div class="particle-table-row" id="gems-buy"><mat-radio-button aria-label="gems"></mat-radio-button>gems Buy</div>
  <div class="particle-table-row">Full Game com.app.fullbook</div>
  <div class="particle-table-row" id="book-buy"><mat-radio-button aria-label="fullbook"></mat-radio-button>fullbook Buy</div>
  <button id="apply">Apply</button></focus-trap>
<material-calendar-picker id="calendar" hidden>
  <div role="gridcell" data-date="2026-11-2"></div><div role="gridcell" data-date="2026-12-1"></div>
</material-calendar-picker>`;

function console_() {
  const dom = new JSDOM(form, {
    url: "https://play.google.com/console/developers/1/app/2/promotions/create",
    runScripts: "outside-only",
  });
  const { window } = dom,
    doc = window.document;
  Object.defineProperty(window.HTMLElement.prototype, "innerText", {
    get() {
      return this.textContent;
    },
  });
  // Laid out unless it or an ancestor is hidden.
  window.Element.prototype.getClientRects = function (this: Element) {
    return (this.closest("[hidden]") ? [] : [{}]) as any;
  };
  window.Element.prototype.scrollIntoView = () => undefined;
  const $ = (id: string) => doc.getElementById(id)!;
  // Play's behaviour: choosing a type reveals "+ Product"; it opens the
  // dialog; Apply shows the chosen option; a day closes the calendar.
  $("otp").addEventListener("click", () => ($("add-product").hidden = false));
  $("add-product").addEventListener(
    "click",
    () => ($("dialog").hidden = false),
  );
  for (const row of ["gems-buy", "book-buy"])
    $(row)
      .querySelector("mat-radio-button")!
      .addEventListener("click", () => {
        doc
          .querySelectorAll(".particle-row-selected")
          .forEach((r) => r.classList.remove("particle-row-selected"));
        $(row).classList.add("particle-row-selected");
      });
  $("apply").addEventListener("click", () => {
    const chosen = doc.querySelector(".particle-row-selected");
    $("chosen").textContent =
      chosen?.id === "book-buy" ? "Full Game - fullbook" : "Gems - gems";
    $("dialog").hidden = true;
  });
  let opened = "";
  for (const id of ["start", "end"])
    $(id).addEventListener("click", () => {
      opened = id;
      $("calendar").hidden = false;
    });
  for (const cell of doc.querySelectorAll("[data-date]"))
    cell.addEventListener("click", () => {
      const [y, m, d] = cell.getAttribute("data-date")!.split("-").map(Number);
      $(opened).firstElementChild!.textContent = new Date(
        Date.UTC(y!, m! - 1, d!),
      ).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      });
      $("calendar").hidden = true;
    });
  const run = (task: PageTask) =>
    window.eval(
      `(${playAssist.toString()})(${JSON.stringify(task)})`,
    ) as ReturnType<typeof playAssist>;
  const until = (task: PageTask) => {
    for (let i = 0; i < 10; i++) if (run(task).done) return true;
    return false;
  };
  return { doc, run, until };
}

it("fills a one-time product promotion the way Play Console's form expects", () => {
  const { doc, run, until } = console_();
  const filled = run({
    step: "fill",
    promo: {
      name: "Launch week",
      productId: "com.app.fullbook",
      kind: "oneTime",
      count: 25,
      start: "2026-11-02",
      end: "2026-11-30",
    },
    productKind: "product",
  });
  expect(filled).toEqual({
    filled: ["promotion name", "promotion type", "number of codes"],
    missing: [],
  });
  const inputs = doc.querySelectorAll<HTMLInputElement>("input[type=text]");
  expect(inputs[0]!.value).toBe("Launch week");
  expect(
    doc.querySelector<HTMLInputElement>("[aria-label='Number of codes']")!
      .value,
  ).toBe("25");
  expect(doc.querySelector<HTMLInputElement>("#otp")!.checked).toBe(true);

  // Picks this product's option, not the first one listed.
  expect(
    until({
      step: "pick-product",
      productId: "com.app.fullbook",
      productTitle: "Full Game",
    }),
  ).toBe(true);
  expect(doc.getElementById("chosen")!.textContent).toBe(
    "Full Game - fullbook",
  );
  expect(
    doc.querySelector<HTMLInputElement>("[aria-label^='Search']")!.value,
  ).toBe("com.app.fullbook");

  expect(
    until({
      step: "pick-date",
      row: "^start date",
      date: "2026-11-2",
      shown: "Nov 2, 2026",
    }),
  ).toBe(true);
  expect(
    until({
      step: "pick-date",
      row: "^end date",
      date: "2026-12-1",
      shown: "Dec 1, 2026",
    }),
  ).toBe(true);
  expect(doc.getElementById("start")!.textContent).toBe("Nov 2, 2026");
  expect(doc.getElementById("end")!.textContent).toBe("Dec 1, 2026");
  // Never presses Save: the person publishes the codes.
  expect(
    [...doc.querySelectorAll("button")].some((b) =>
      /save/i.test(b.textContent ?? ""),
    ),
  ).toBe(false);
});
