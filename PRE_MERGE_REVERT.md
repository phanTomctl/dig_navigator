# Pre-merge revert checklist (DIG Lab → main)

This branch packages the app as **`dig_navigator_lab`** so it can install beside production **`dig_navigator`**.

Before merging into `main` / production, restore production identity:

1. Rename installable root: `dig_navigator_lab/` → `dig_navigator/`
2. Global replace in the app tree: `dig_navigator_lab` → `dig_navigator`
3. Restore [`dig_navigator/default/app.conf`](dig_navigator/default/app.conf):
   - `label = Data Intelligence & Governance`
   - `version = 1.0.0` (or the current production version)
   - Restore the production launcher description
4. Delete this file (`PRE_MERGE_REVERT.md`)
5. Confirm no remaining `dig_navigator_lab` references:
   ```bash
   rg dig_navigator_lab
   ```
6. Deploy/test once more as `dig_navigator` before merge

**Keep for main:** SA_CIM field/tag metadata build, agreed field SPL (`source_url=/services/data/models`, recommended/required as 1/0, no `table_index`), and Data Intelligence `base_sample` efficiency.
