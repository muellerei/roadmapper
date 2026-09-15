#!/usr/bin/env bash
# The boundary of ADR-0003 and ADR-0008, made runnable: each stage may use
# only the names it owns.
#
#     src/source/gitlab/   GitLab field names live here, nowhere else
#     src/core/            names neither a GitLab field nor a Notion term
#     src/output/notion/   Notion terms live here, nowhere else
#
# WHICH list applies therefore depends on the directory. Checking both
# everywhere would flag the output stage for using Notion's own vocabulary at
# the one place it belongs — the rule is about names in the WRONG stage, not
# about the names as such.
#
# The lists are EXHAUSTIVE and live HERE and nowhere else. Seven places in the
# plan call this script; when the list was copied by hand into four of them,
# one had already drifted to 7 of the 18 terms.
#
# What is NOT on them, deliberately: title, state, name, updatedAt,
# description. They appear in GitLab's WorkItem too, but a general word does
# not belong to GitLab just because GitLab uses it — and the seam types in
# docs/architecture.md are built from them. A grep for "GitLab field names"
# would have flagged the project's own vocabulary.
set -uo pipefail

target="${1:-src/core/}"

gitlab='iid|webUrl|webPath|widgets|workItems|nodes|rolledUpCountsByType|rolledUpHealthStatus|healthStatus|depthLimitReachedByType|hasChildren|stats|statuses|totalIssuesCount|closedIssuesCount'
notion='data_source_id|properties|rich_text'

case "$target" in
  *source*) forbidden="$notion"; owns='the source stage owns GitLab field names' ;;
  *output*) forbidden="$gitlab"; owns='the output stage owns Notion terms' ;;
  *)        forbidden="${gitlab}|${notion}"; owns='the core owns neither vocabulary' ;;
esac

# Identifier boundaries, not word boundaries: `properties` must not fire on
# the English word in a comment, and `stats` must not fire inside
# statsOfSomething. A hit therefore needs a non-identifier character on both
# sides.
pattern="(^|[^A-Za-z0-9_])(${forbidden})([^A-Za-z0-9_]|\$)"

# Only lines that use the term as CODE count.
#
# Two exemptions, both narrow:
#
#  - a COMMENT line: prose about the boundary is not a crossing of it, and
#    the modules have to be able to explain why these names stay outside.
#  - a term followed by a SPACE: that is running text in a user-facing
#    message ("GitLab statuses found: ..."), not a field access. Spec
#    section 9 prescribes that sentence verbatim. A field access never has a
#    space after the name — `dataSource.properties` and `widgets {` do not
#    match this, and a GraphQL query string, where a field name genuinely is
#    a field access, lives in src/source/gitlab/ where that list is not
#    checked anyway.
hits=$(grep -rInE "$pattern" "$target" --include='*.ts' \
  | grep -vE '^[^:]+:[0-9]+:[[:space:]]*(//|/\*|\*)' \
  | grep -E "(^|[^A-Za-z0-9_])(${forbidden})([^A-Za-z0-9_ ]|\$)" \
  || true)

if [ -n "$hits" ]; then
  echo "Boundary violation in ${target} — ${owns}:" >&2
  echo "$hits" >&2
  echo >&2
  echo "See ADR-0003, ADR-0008 and docs/architecture.md." >&2
  exit 1
fi

exit 0
