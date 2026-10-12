# Third-party notices

Dispatch is licensed under [Apache-2.0](LICENSE). Third-party components retain their respective copyrights and license terms; the project license does not replace them.

## JavaScript and local EVM dependencies

The [npm inventory](licenses/npm-inventory.json) records all 288 external package occurrences in the two lockfiles, including exact versions, package integrities, optional platforms and collected license/notice texts. The [upstream inventory](licenses/upstream-inventory.json) supplies additional license texts and their source bindings for installed packages whose archives omit top-level notices. Duplicate and nested packages are retained in the inventory.

The locked components use MIT, Apache-2.0, MPL-2.0, ISC, BSD-3-Clause, 0BSD, or MIT OR Apache-2.0. `memorystream` 0.3.1 identifies MIT in its package's plural `licenses` field and bundled license. The `react-remove-scroll-bar` 2.3.8 notice comes from its upstream project: its archive is identical to 2.3.7 except for the version and `react-style-singleton` dependency range in package metadata, and the later source commit adds only the license. The inventory records both archive integrities and that source comparison.

MPL-2.0 components include axe-core and Lightning CSS. Their file-level terms apply independently of Dispatch's license. The Anvil package declares MIT OR Apache-2.0. Full copyright, permission and notice texts are retained under `licenses/third-party/` and `licenses/upstream/`.

## Build recipes and external tools

The edge recipe builds Caddy 2.11.7 with the checked-in Go module graph and fixed Go toolchain. Its modified dependency selection includes `golang.org/x/net` 0.60.0. The recipe includes Caddy, Go and x/net license texts in the resulting image. Python validator versions are specified in the checked-in requirements.

This repository distributes source and build recipes, without installed npm/Python dependencies, browser or EVM binaries, container images, or OS packages. Those separately obtained components remain subject to their own licenses and redistribution obligations, including applicable notices and source availability. The inventories describe source dependencies and collected notices; they are not a notice manifest for a bundled binary or container distribution.

The sample in `examples/assets/guide.txt` is original demonstration text. No customer branding or third-party recording media is included.
