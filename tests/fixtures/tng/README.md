`constants.hpp`, `buttons.cpp` and `commands.cpp` are `src/constants.hpp`,
`src/buttons.cpp` and `src/commands.cpp` of TonUINO-TNG (master, version 3.3.3
of 17.09.2026, https://github.com/tonuino/TonUINO-TNG), unchanged, GPL-3.0.

The tests of the Lötplan (tests/workshop/tngpins.test.ts) read `constants.hpp`
to check every pin the app draws against the firmware itself. Keep it byte for
byte: the pin table in src/features/workshop/tngPins.ts cites its line numbers.

The test of the key texts (tests/tonuino/keytexts.test.ts) reads `buttons.cpp`
and `commands.cpp` for the keys that open the admin menu and erase the
settings at power-on, with three keys and with five.

Copyright: the authors of TonUINO-TNG (based on TonUINO by Thorsten Voß).
Licence: GNU General Public License, version 3; the full text is in LICENSE
at the root of this repository and at https://www.gnu.org/licenses/gpl-3.0.txt.
