import React from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/dm-sans/400.css";
import "@fontsource/dm-sans/500.css";
import "@fontsource/dm-sans/600.css";
import "@fontsource/dm-sans/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "./style.css";
import { MobileApp } from "./MobileApp";
const pair = new URLSearchParams(location.hash.slice(1)).get("pair");
if (pair) history.replaceState(null, "", location.pathname + "#now");
createRoot(document.getElementById("root")!).render(
  <MobileApp initialPair={pair} />,
);
