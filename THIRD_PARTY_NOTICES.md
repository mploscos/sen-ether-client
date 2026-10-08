# Third-party notices

The original JavaScript implementation, tests and project documentation are
distributed under this project's MIT license.

The following files are unmodified, byte-identical copies from
[Airbus Sen](https://github.com/airbus/sen), release `0.6.0`, commit
`48f329aa67c65518eb4299b50564d345ed1d54f0` (2026-04-17):

| Packaged file | Upstream path | SHA-256 |
| --- | --- | --- |
| `resources/protocol/ether/runtime.stl` | `components/ether/stl/runtime.stl` | `265aaa321516f7687366604772a0e89301ff40e33ca7920e38eda7c326f1f987` |
| `resources/protocol/ether/discovery.stl` | `components/ether/stl/discovery.stl` | `ad7950f78b11a336bb5d089901b605c696aa29a5dd7ec5ce550bc848dc307484` |
| `resources/protocol/kernel/bus_protocol.stl` | `libs/kernel/src/bus/bus_protocol.stl` | `ea50732dfdcced152f5e32eee031bfc5bb4ab5cac4ff5942d5d7bc452d4ff763` |
| `resources/protocol/kernel/basic_types.stl` | `libs/kernel/stl/sen/kernel/basic_types.stl` | `8ad91041a51cd6cdcba76bec531dd00bff3e35388f1ef8e020685290aa82bde5` |
| `resources/protocol/kernel/type_specs.stl` | `libs/kernel/stl/sen/kernel/type_specs.stl` | `61fe1976022ee5c961b84ebbf8fc56a22d0222a0c45e7d085b327b5f8b616a63` |

Those files are provided under Apache License 2.0; a copy is in
`LICENSES/Apache-2.0.txt`. None of the five files has local modifications.

`resources/protocol/protocol.json`, `scripts/generate-protocol.mjs` and the
JavaScript generated from that metadata are original project integration and
generation files. This notice records provenance and is not legal advice; the
license treatment and any downstream distribution obligations should receive
human review before an official Sen adoption.

## RPR FOM 2.0

The XML modules under `resources/fom/rpr` are unmodified copies of the
SISO-STD-001.1-2015 Real-time Platform Reference Federation Object Model 2.0,
obtained from the Sen 0.6.0 distribution.

Copyright © 2015 by the Simulation Interoperability Standards Organization,
Inc. All rights reserved. Reprinted with permission from SISO Inc. The schema
and API redistribution grant is reproduced in
`LICENSES/SISO-RPR-FOM.txt` and in each XML module.
