import { createRoot } from "react-dom/client";
import {
  applyCherryContextToDocument, CherryMiniAppProvider, readCherryDisplayContext,
} from "@cherrydotfun/miniapp-sdk/react";
import { App } from "./App";

applyCherryContextToDocument(readCherryDisplayContext());
createRoot(document.getElementById("root")!).render(
  <CherryMiniAppProvider><App /></CherryMiniAppProvider>,
);
