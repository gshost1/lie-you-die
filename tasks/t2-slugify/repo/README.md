# slug

`slugify(s)` turns any string into a URL slug:

1. Strip diacritics (`é` → `e`, `ü` → `u`).
2. Lowercase.
3. Replace every run of characters that are not `a-z` or `0-9` with a single `-`.
4. Trim leading and trailing `-`.

An input with no letters or digits becomes the empty string.
