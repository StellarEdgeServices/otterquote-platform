// gh-1462: native flat config (eslint 9 + eslint-config-next 16). The FlatCompat shim is gone.
//
// eslint-config-next@16 pulls in eslint-plugin-react-hooks@7, whose new React-Compiler-derived
// rules flag existing, working code (measured 2026-09-29: 82 errors on main's sources, 70 of
// them set-state-in-effect). Turning those into hard errors would need ~80 source edits that
// are out of scope for a tooling change and would not be reviewable as "no behaviour change".
// So the five NEW rules are kept ON at "warn": every finding is still printed, nothing is
// switched off, and each can be promoted to "error" file-by-file as the code is cleaned up.
// Rules that existed before this change keep their previous severity (next/core-web-vitals).
import coreWebVitals from "eslint-config-next/core-web-vitals";

const NEW_REACT_HOOKS_V7_RULES = [
  "react-hooks/set-state-in-effect",
  "react-hooks/refs",
  "react-hooks/purity",
  "react-hooks/globals",
  "react-hooks/immutability",
];

const eslintConfig = [
  ...coreWebVitals,
  {
    name: "gh-1462/react-hooks-v7-new-rules-as-warn",
    rules: Object.fromEntries(NEW_REACT_HOOKS_V7_RULES.map((r) => [r, "warn"])),
  },
];

export default eslintConfig;
