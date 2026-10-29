#!/usr/bin/env bash
# The workspace this case starts in: the suite's one fixture, variant `ambiguous`.
exec bash "$(dirname "${BASH_SOURCE[0]}")/../_fixture/seed.sh" ambiguous
