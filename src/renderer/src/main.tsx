import React from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/dm-sans/400.css";
import "@fontsource/dm-sans/500.css";
import "@fontsource/dm-sans/600.css";
import "@fontsource/dm-sans/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "./style.css";
import { AccountSetup } from "./AccountSetup";
import { App } from "./App";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {new URLSearchParams(location.search).has("account") ? (
      <AccountSetup />
    ) : (
      <App />
    )}
  </React.StrictMode>,
);
