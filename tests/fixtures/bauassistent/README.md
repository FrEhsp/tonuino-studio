`geprueft-stufen.json` lists every connection of the checked notes of the
build assistant (`bauassistent/geprueft/*.json` in the project files, state
of 13.10.2026) with its confidence (`belegt`, `wahrscheinlich`, `unsicher`)
and the result of their adversarial check. Generated from those files, only
id, file, confidence and check result.

tests/workshop/loetplan-belege.test.ts reads it: no proof of the Lötplan
(src/features/workshop/loetplanBelege.ts) may be stronger than the notes it
stands for.
