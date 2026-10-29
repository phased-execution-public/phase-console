#!/usr/bin/env bash
#
# A wizard walks a human through a manual procedure, step by step — a fixture
# in the shape of mattpocock's wizard/template.sh (the library above the
# STAGES marker is elided here; the reader never reads it).

set -euo pipefail

TOTAL_STAGES=0
ENV_FILE="${ENV_FILE:-.env.local}"

stage() { :; }; say() { :; }; step() { :; }; open_url() { :; }
ask() { :; }; ask_secret() { :; }; write_env() { :; }; set_secret() { :; }
set_var() { :; }; confirm() { :; }; banner() { :; }; finish() { :; }

# ──────────────────────────────────────────────────────────────────────────
# STAGES: author this section. One stage() per step the human takes.
# ──────────────────────────────────────────────────────────────────────────

run_wizard() {

TOTAL_STAGES=3

banner "Deploy setup"

stage "Vercel: project id"
say "We'll read the project id the deploy needs."
open_url "https://vercel.com/acme/web/settings"
step "Copy the Project ID under General."
ask VERCEL_PROJECT_ID "Paste the project id:"
write_env VERCEL_PROJECT_ID "$VERCEL_PROJECT_ID"

stage "Vercel: deploy token"
open_url "https://vercel.com/account/tokens"
step "Create a token named ci-deploy, then copy it."
ask_secret VERCEL_TOKEN "Paste the deploy token:"
write_env VERCEL_TOKEN "$VERCEL_TOKEN"
set_secret VERCEL_TOKEN "$VERCEL_TOKEN"   # CI needs this one
set_var VERCEL_ORG "acme"

stage "Signing key passphrase"
step "Read the passphrase from the team vault entry 'release signing'."
ask_secret SIGNING_PASSPHRASE "Paste the passphrase:"
confirm "Store it now?"

finish
}

run_wizard "$@"; exit
