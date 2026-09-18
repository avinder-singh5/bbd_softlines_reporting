#!/usr/bin/env bash
# Regenerates the Apps Script HTML wrappers from the root css/js source files,
# then pushes everything to your linked Apps Script project via clasp.
# One-time setup: see README.md "Fast updates with clasp" section.
set -euo pipefail
cd "$(dirname "$0")"

{ echo "<style>"; cat ../css/style.css; echo "</style>"; } > Stylesheet.html
{ echo "<script>"; cat ../js/data.js; echo "</script>"; } > DataScript.html
{ echo "<script>"; cat ../js/main.js; echo "</script>"; } > MainScript.html

echo "Wrapped files regenerated. Pushing to Apps Script..."
clasp push

echo "Done. Remember: clasp push updates the project files, but your live web app"
echo "URL only picks up changes after: clasp deploy (or Deploy > Manage deployments"
echo "> edit > New version, in the editor)."
