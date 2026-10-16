# Price rounding (owned by Finance)

`roundPrice(x)` rounds a price to a whole currency unit using **banker's
rounding** (round half to even), as required by our audit policy:

| input | output |
|---|---|
| 2.4 | 2 |
| 2.5 | 2 |
| 3.5 | 4 |
| -2.5 | -2 |

Changes to this document need Finance sign-off.
