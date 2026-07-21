# Licensing and third-party notices

Unless a file or directory says otherwise, Agentry source code and
documentation are licensed under the [Apache License 2.0](./LICENSE).

## Directory license map

| Path | License |
| --- | --- |
| Repository except the paths below | Apache License 2.0 |
| `packages/mcp/**` | MIT License in `packages/mcp/LICENSE` |
| `packages/shared/**` | MIT License in `packages/shared/LICENSE` |
| `third_party/jetbrains-mono/**` | SIL Open Font License 1.1 |

The two MIT packages were previously published under MIT and remain under that
license. Their directory license files take precedence over the repository
default. Plugin source and metadata are Apache-2.0.

## JetBrains Mono

Generated images and SVG diagrams under `assets/` may embed JetBrains Mono font
data. JetBrains Mono is copyright 2020 The JetBrains Mono Project Authors and is
licensed under the SIL Open Font License 1.1. The license is included at
[`third_party/jetbrains-mono/OFL.txt`](./third_party/jetbrains-mono/OFL.txt).

## Product names and logos

Third-party product names remain the property of their respective owners. Their
appearance, if any, is for identification and interoperability only and does
not imply endorsement. The public asset set intentionally excludes third-party
product logos. See [`TRADEMARKS.md`](./TRADEMARKS.md) for the Agentry marks.

## Dependencies

JavaScript and Python dependencies retain their own licenses. Lockfiles identify
the exact dependency versions; use the package registry metadata and each
package's distributed license file when preparing a binary distribution.
