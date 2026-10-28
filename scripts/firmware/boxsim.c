// A whole TonUINO box in simavr, for testing the app against the real
// TonUINO-TNG firmware (TODO #66, docs/BOX-SIMULATOR.md). The flash image of a
// build of the Firmware-Baukasten runs on a simulated ATmega328P at 16 MHz;
// around it sit a DFPlayer Mini on the firmware's SoftwareSerial (D2/D3,
// 9600 baud, busy on D4) with a small pretend SD card, an MFRC522 card reader
// on SPI (SS D10) with MIFARE Classic 1K, Ultralight and NTAG cards, the
// buttons, headphone jack (D8), rotary encoder or poti (A3/A4) and the USB
// serial port (115200 baud). Not part of the app.
//
// Build and run (scripts/firmware/boxsim-run.mjs does both for the tests):
//   gcc -O2 -o boxsim scripts/firmware/boxsim.c -I/usr/include/simavr -lsimavr
//   ./boxsim [options] firmware.bin|firmware.hex < script
//
// Options:
//   --buttons 3|5|3x3    key wiring (default: what the box prints at its start, "C 5")
//   --board classic|aio  pin layout (default classic; the AiO's LGT8F328P runs as ATmega328P)
//   --sd 1:12,2:5        folders and their track counts (default 1:10,2:10,3:10,4:10,5:10)
//   --track-seconds S    length of every folder track (default 20)
//   --sounds FILE        mp3/advert lengths and texts (boxsim-sounds.tsv)
//   --mp3-boot S         DFPlayer ready S seconds after power on (default 0.3)
//   --mp3-start S        busy pin goes low S seconds after a play command (default 0.15)
//   --mp3-double-finish  the DFPlayer reports every track end twice (many clones do)
//   --no-mp3             no MP3 player answers
//   --no-rfid            no card reader on SPI
//   --rfid-version N     MFRC522 VersionReg (default 0x92 = v2.0; 0x88 clone, 0x12 counterfeit)
//   --bat-pin MV         voltage at A5, the battery measurement (BAT_VOLTAGE_MEASUREMENT; behind a
//                        100k/100k divider half the battery voltage; default 0)
//   --reqa-answers       a selected card answers the reader's next REQA. Default is ISO 14443-3: it
//                        falls back to IDLE silently, so TNG's polling (chip_card.cpp getCardEvent)
//                        finds the card only every second time and leaves it unselected half of the
//                        time, and writing at the box then fails with "Auth failed: 3" by chance
//                        (docs/BOX-SIMULATOR.md)
//   --eeprom FILE        load the EEPROM from FILE (if it exists) and save it there at the end
//   --realtime[=X]       run at X times real time (default 1) and read stdin while running;
//                        without it, time only passes during wait/until/press (lockstep)
//   --quiet              no rfid/mp3/key events, only box lines and command results
//
// Script (one command per line on stdin; '#' starts a comment):
//   wait S                         let S seconds pass
//   until TEXT [S]                 run until a box line or event contains TEXT (default 30 s); what
//                                  the command just before caused counts too ("press up", "until Volume")
//   press KEYS [short|long|MS]     KEYS: pause, up, down, four, five, joined with + ("pause+up+down")
//   hold KEYS / release KEYS|all   keep keys down, e.g. while switching on
//   turn left|right [N]            rotary encoder
//   poti PERCENT                   potentiometer
//   hp in|out                      headphones (D8 high = plugged in, TNG constants.hpp)
//   card TYPE [uid=HEX] [data=HEX] [tonuino=F,M[,S1,S2]] [key=HEX] [flaky=P] [readonly]
//                                  lay a card on the reader; TYPE classic|ultralight|ntag213|ntag215|ntag216;
//                                  data is block 4 (Classic) or pages 8-11; a card keeps its memory by UID
//   card off                       take the card off
//   cards                          print the cards the simulation knows
//   serial TEXT                    send TEXT and "\n" to the box's USB serial port
//   tx HEX                         send raw bytes to the USB serial port
//   reset                          reset over DTR (only the microcontroller restarts)
//   power off|on|cycle             switch the whole box; the EEPROM stays
//   mp3 error N                    the DFPlayer reports error N
//   sd out|in                      pull the SD card / put it back
//   eeprom [FILE]                  print the EEPROM settings bytes or save them to FILE
//   quit
// Every command answers "=ok N" or "=fail N reason" (N counts the commands from 1).
//
// Output, one line per event with the simulated time:
//   [   1.234] box| <line from the USB serial port>
//   [   1.234] mp3| play 03/005 (20.0 s), says mp3/0300 "Oh, eine neue Karte!", volume 15, ...
//   [   1.234] rfid| card on / off / block 4 written ...
//   [   1.234] key| ...    sim| ...
#define _GNU_SOURCE
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <math.h>
#include <poll.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <simavr/avr_adc.h>
#include <simavr/avr_eeprom.h>
#include <simavr/avr_ioport.h>
#include <simavr/avr_spi.h>
#include <simavr/avr_uart.h>
#include <simavr/sim_avr.h>
#include <simavr/sim_hex.h>

// Private in simavr, but exported: runs due cycle timers while the CPU is off.
avr_cycle_count_t avr_cycle_timer_process(avr_t *avr);

#define F_CPU 16000000.0
#define CYC(sec) ((avr_cycle_count_t)((sec) * F_CPU + 0.5))

static avr_t *avr;
static int quiet;
static int failures;

static double now(void) { return (double)avr->cycle / F_CPU; }

// Lines seen while "until" waits for one.
static char watch_text[256];
static int watch_hit;

// What the last command (or "until" after it) caused: "press up" then "until Volume" also finds a
// line that came while the key was still down.
static char history[512][160];
static int hist_n;
static void history_add(const char *line) {
  if (hist_n == 512) {
    memmove(history[0], history[1], sizeof history - sizeof history[0]);
    hist_n--;
  }
  snprintf(history[hist_n++], sizeof history[0], "%.159s", line);
}
static int history_find(const char *text) {
  for (int i = 0; i < hist_n; i++)
    if (strstr(history[i], text)) {
      memmove(history[0], history[i + 1], (size_t)(hist_n - i - 1) * sizeof history[0]);
      hist_n -= i + 1;
      return 1;
    }
  return 0;
}

static void ev(const char *tag, const char *fmt, ...) {
  char buf[700];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(buf, sizeof buf, fmt, ap);
  va_end(ap);
  if (tag[0] != '>' && tag[0] != '=') {
    if (watch_text[0] && strstr(buf, watch_text)) watch_hit = 1;
    else if (!watch_text[0]) history_add(buf);
  }
  if (quiet && strcmp(tag, "box") && strcmp(tag, "sim") && tag[0] != '=') return;
  printf("[%9.3f] %s| %s\n", now(), tag, buf);
}
#define evw ev

static avr_irq_t *pin_irq(char port, int bit) { return avr_io_getirq(avr, AVR_IOCTL_IOPORT_GETIRQ(port), bit); }
// A level from outside on an input pin. simavr also needs it as the port's "external" level:
// otherwise every write to the port puts the input back to the pull-up's high level.
static uint8_t ext_mask[3], ext_value[3];
static void pin_set(char port, int bit, int level) {
  int i = port - 'B';
  ext_mask[i] |= (uint8_t)(1 << bit);
  if (level) ext_value[i] |= (uint8_t)(1 << bit);
  else ext_value[i] &= (uint8_t)~(1 << bit);
  avr_ioport_external_t e = {.name = port, .mask = ext_mask[i], .value = ext_value[i]};
  avr_ioctl(avr, AVR_IOCTL_IOPORT_SET_EXTERNAL(port), &e);
  avr_raise_irq(pin_irq(port, bit), level ? 1 : 0);
}

// ------------------------------------------------------------------ configuration

static struct {
  int buttons;  // 0 unknown, 3, 5, 9 (3x3)
  int aio;
  double track_seconds;
  double mp3_boot, mp3_start;
  int double_finish;
  int no_mp3, no_rfid;
  // A selected card answers the next REQA instead of falling back to IDLE silently (ISO 14443-3).
  int reqa_answers;
  int rfid_version;
  int bat_pin_mv;
  const char *eeprom_file;
  double realtime;  // 0: lockstep
} cfg = {.track_seconds = 20.0, .mp3_boot = 0.3, .mp3_start = 0.15, .rfid_version = 0x92};

// ------------------------------------------------------------------ USB serial (UART0)

static char uline[600];
static int ulen;
static int boot_buttons_seen;

static void uart_out(struct avr_irq_t *irq, uint32_t value, void *param) {
  (void)irq;
  (void)param;
  char c = (char)value;
  if (c == '\r') return;
  if (c == '\n' || ulen == (int)sizeof(uline) - 1) {
    uline[ulen] = 0;
    evw("box", "%s", uline);
    // "C 3", "A 5", "C 3x3": the wiring of the keys, when no --buttons was given.
    if (!cfg.buttons && (uline[0] == 'C' || uline[0] == 'A') && uline[1] == ' ') {
      if (!strcmp(uline + 2, "5")) cfg.buttons = 5;
      else if (!strcmp(uline + 2, "3x3")) cfg.buttons = 9;
      else if (!strcmp(uline + 2, "3")) cfg.buttons = 3;
      if (cfg.buttons) boot_buttons_seen = 1;
    }
    ulen = 0;
    return;
  }
  uline[ulen++] = c;
}

static uint8_t host_q[8192];
static int host_head, host_tail;
static avr_cycle_count_t host_feed(avr_t *a, avr_cycle_count_t when, void *param) {
  (void)param;
  if (host_head == host_tail) return 0;
  avr_raise_irq(avr_io_getirq(a, AVR_IOCTL_UART_GETIRQ('0'), UART_IRQ_INPUT), host_q[host_tail]);
  host_tail = (host_tail + 1) % (int)sizeof host_q;
  return when + CYC(0.0001);  // a byte per 100 us, a bit slower than 115200 baud
}
static void host_send(const uint8_t *data, int n) {
  int idle = host_head == host_tail;
  for (int i = 0; i < n; i++) {
    int next = (host_head + 1) % (int)sizeof host_q;
    if (next == host_tail) break;
    host_q[host_head] = data[i];
    host_head = next;
  }
  if (idle) avr_cycle_timer_register(avr, 1, host_feed, NULL);
}

// ------------------------------------------------------------------ SoftwareSerial to the DFPlayer

// 9600 baud. The AiO's LGT8F328P runs SoftwareSerial's delay loop in 4 cycles (lgt8fx
// SoftwareSerial.cpp _delay_loop_2: its SBIW takes one), simavr counts the ATmega's 5: in
// simulated time its bits are 1.25 times as long, and the pretend DFPlayer goes along.
static double bit_cyc = F_CPU / 9600.0;
#define BIT_CYC bit_cyc

// MCU TX on D3 (PD3), decoded here.
static int mcu_tx_level = 1;
static int dec_active, dec_bit;
static avr_cycle_count_t dec_start;
static uint8_t dec_byte;
static void mp3_rx_byte(uint8_t b);

static avr_cycle_count_t dec_sample(avr_t *a, avr_cycle_count_t when, void *param) {
  (void)a;
  (void)when;
  (void)param;
  if (dec_bit < 8) {
    if (mcu_tx_level) dec_byte |= (uint8_t)(1 << dec_bit);
    dec_bit++;
    return dec_start + (avr_cycle_count_t)((1.5 + dec_bit) * BIT_CYC);
  }
  dec_active = 0;
  if (mcu_tx_level) mp3_rx_byte(dec_byte);  // stop bit high, else a framing error
  return 0;
}
static void mcu_tx_change(struct avr_irq_t *irq, uint32_t value, void *param) {
  (void)irq;
  (void)param;
  int level = value ? 1 : 0;
  if (level == mcu_tx_level) return;
  mcu_tx_level = level;
  if (!level && !dec_active) {
    dec_active = 1;
    dec_bit = 0;
    dec_byte = 0;
    dec_start = avr->cycle;
    avr_cycle_timer_register(avr, (avr_cycle_count_t)(1.5 * BIT_CYC), dec_sample, NULL);
  }
}

// MCU RX on D2 (PD2), driven here.
static uint8_t to_mcu[512];
static int to_head, to_tail;
static int enc_phase;  // 0 idle, 1 start bit sent, 2..9 data bits, 10 stop bit
static avr_cycle_count_t enc_t0;
static avr_cycle_count_t enc_step(avr_t *a, avr_cycle_count_t when, void *param) {
  (void)a;
  (void)param;
  if (enc_phase == 0) {
    if (to_head == to_tail) return 0;
    enc_t0 = when;
    pin_set('D', 2, 0);
    enc_phase = 1;
  } else if (enc_phase <= 8) {
    pin_set('D', 2, (to_mcu[to_tail] >> (enc_phase - 1)) & 1);
    enc_phase++;
  } else {
    pin_set('D', 2, 1);
    to_tail = (to_tail + 1) % (int)sizeof to_mcu;
    enc_phase = 0;
    return enc_t0 + (avr_cycle_count_t)(10 * BIT_CYC);
  }
  return enc_t0 + (avr_cycle_count_t)(enc_phase * BIT_CYC);
}
static void to_mcu_send(const uint8_t *d, int n) {
  int idle = to_head == to_tail && enc_phase == 0;
  for (int i = 0; i < n; i++) {
    to_mcu[to_head] = d[i];
    to_head = (to_head + 1) % (int)sizeof to_mcu;
  }
  if (idle) {
    avr_cycle_timer_cancel(avr, enc_step, NULL);
    avr_cycle_timer_register(avr, 1, enc_step, NULL);
  }
}

// ------------------------------------------------------------------ DFPlayer Mini

typedef struct {
  int num;
  double sec;
  char text[200];
} sound_t;
static sound_t sounds_mp3[1000], sounds_adv[1000];
static int sounds_loaded;

static int sd_tracks[100];  // tracks per folder 01..99
static int sd_in = 1;

enum { P_STOP, P_PLAY, P_PAUSE };
enum { K_FOLDER, K_MP3, K_ADV };
typedef struct {
  int kind, folder, track;
  double len, played;  // seconds
  avr_cycle_count_t since;  // cycle when it last started running
  int index;  // number reported in "track finished"
} play_t;

static struct {
  int powered, online;
  int vol, eq;
  int state;  // P_*
  int starting;  // busy goes low after mp3_start
  play_t cur;
  int adv_active;
  play_t main;  // the track an advertisement interrupts
  int main_state;
  uint8_t frame[10];
  int flen;
  uint8_t reply[64][10];
  int nreply;
} mp3;

static int mp3_count_total(void) {
  int n = 0;
  for (int f = 1; f < 100; f++) n += sd_tracks[f];
  for (int i = 0; i < 1000; i++) n += (sounds_mp3[i].num != 0) + (sounds_adv[i].num != 0);
  return n;
}

static void mp3_busy(int playing) { pin_set('D', 4, playing ? 0 : 1); }

static avr_cycle_count_t mp3_reply_send(avr_t *a, avr_cycle_count_t when, void *param) {
  (void)a;
  (void)when;
  (void)param;
  for (int i = 0; i < mp3.nreply; i++) to_mcu_send(mp3.reply[i], 10);
  mp3.nreply = 0;
  return 0;
}
static void mp3_reply(uint8_t cmd, uint16_t arg, double delay) {
  if (cfg.no_mp3 || !mp3.powered) return;
  uint8_t *p = mp3.reply[mp3.nreply < 63 ? mp3.nreply++ : 63];
  p[0] = 0x7e; p[1] = 0xff; p[2] = 6; p[3] = cmd; p[4] = 0; p[5] = arg >> 8; p[6] = arg & 0xff;
  uint16_t sum = 0;
  for (int i = 1; i < 7; i++) sum -= p[i];
  p[7] = sum >> 8; p[8] = sum & 0xff; p[9] = 0xef;
  if (!avr_cycle_timer_status(avr, mp3_reply_send, NULL)) avr_cycle_timer_register(avr, CYC(delay), mp3_reply_send, NULL);
}

static const char *sound_text(int kind, int num) {
  sound_t *s = kind == K_MP3 ? &sounds_mp3[num % 1000] : &sounds_adv[num % 1000];
  static char buf[220];
  if (s->num && s->text[0]) snprintf(buf, sizeof buf, " \"%s\"", s->text);
  else if (num >= 1 && num <= 255) snprintf(buf, sizeof buf, " \"%d\"", num);
  else buf[0] = 0;
  return buf;
}

static void play_name(const play_t *p, char *out, size_t n) {
  if (p->kind == K_FOLDER) snprintf(out, n, "%02d/%03d", p->folder, p->track);
  else snprintf(out, n, "%s/%04d", p->kind == K_MP3 ? "mp3" : "advert", p->track);
}

static avr_cycle_count_t mp3_track_end(avr_t *a, avr_cycle_count_t when, void *param);
static avr_cycle_count_t mp3_started(avr_t *a, avr_cycle_count_t when, void *param);

// Starts (or resumes) cur: busy low after the start delay, then the end timer.
static void mp3_run_cur(double start_delay) {
  avr_cycle_timer_cancel(avr, mp3_track_end, NULL);
  avr_cycle_timer_cancel(avr, mp3_started, NULL);
  mp3.state = P_PLAY;
  mp3.starting = 1;
  avr_cycle_timer_register(avr, CYC(start_delay) + 1, mp3_started, NULL);
}
static avr_cycle_count_t mp3_started(avr_t *a, avr_cycle_count_t when, void *param) {
  (void)a;
  (void)param;
  mp3.starting = 0;
  mp3.cur.since = when;
  mp3_busy(1);
  double left = mp3.cur.len - mp3.cur.played;
  if (left < 0.01) left = 0.01;
  avr_cycle_timer_register(avr, CYC(left), mp3_track_end, NULL);
  return 0;
}
static void mp3_halt(int new_state) {
  if (mp3.state == P_PLAY && !mp3.starting) mp3.cur.played += (double)(avr->cycle - mp3.cur.since) / F_CPU;
  avr_cycle_timer_cancel(avr, mp3_track_end, NULL);
  avr_cycle_timer_cancel(avr, mp3_started, NULL);
  mp3.starting = 0;
  mp3.state = new_state;
  mp3_busy(0);
}

static avr_cycle_count_t mp3_resume_main(avr_t *a, avr_cycle_count_t when, void *param) {
  (void)a;
  (void)when;
  (void)param;
  mp3.cur = mp3.main;
  mp3.adv_active = 0;
  if (mp3.main_state == P_PLAY) {
    char name[32];
    play_name(&mp3.cur, name, sizeof name);
    ev("mp3", "back to %s", name);
    mp3_run_cur(0.03);
  } else mp3.state = mp3.main_state;
  return 0;
}

static avr_cycle_count_t mp3_track_end(avr_t *a, avr_cycle_count_t when, void *param) {
  (void)a;
  (void)when;
  (void)param;
  char name[32];
  play_name(&mp3.cur, name, sizeof name);
  mp3.state = P_STOP;
  mp3_busy(0);
  if (mp3.cur.kind == K_ADV && mp3.adv_active) {
    // The original DFPlayer reports no end for an advertisement; it goes back to the track.
    ev("mp3", "end of %s", name);
    avr_cycle_timer_register(avr, CYC(0.03), mp3_resume_main, NULL);
    return 0;
  }
  ev("mp3", "end of %s", name);
  mp3_reply(0x3d, (uint16_t)mp3.cur.index, 0.005);
  if (cfg.double_finish) mp3_reply(0x3d, (uint16_t)mp3.cur.index, 0.005);
  return 0;
}

static double sound_len(int kind, int num) {
  sound_t *s = kind == K_MP3 ? &sounds_mp3[num % 1000] : &sounds_adv[num % 1000];
  if (s->num) return s->sec > 0.05 ? s->sec : 0.05;
  return sounds_loaded ? -1 : 1.0;  // without the table every sound lasts a second
}

// Starts a file; returns 0 when it is not on the card.
static int mp3_play(int kind, int folder, int track) {
  play_t p = {kind, folder, track, 0, 0, 0, 0};
  if (!sd_in) return 0;
  if (kind == K_FOLDER) {
    if (folder < 1 || folder > 99 || track < 1 || track > sd_tracks[folder]) return 0;
    p.len = cfg.track_seconds;
    p.index = 2000 + folder * 256 + track;
  } else {
    p.len = sound_len(kind, track);
    if (p.len < 0) return 0;
    p.index = (kind == K_MP3 ? 0 : 1000) + track;
  }
  if (mp3.state != P_STOP) mp3_halt(P_STOP);
  mp3.adv_active = 0;
  mp3.cur = p;
  char name[32];
  play_name(&p, name, sizeof name);
  if (kind == K_FOLDER) ev("mp3", "play %s (%.1f s), volume %d", name, p.len, mp3.vol);
  else ev("mp3", "says %s%s, volume %d", name, sound_text(kind, track), mp3.vol);
  mp3_run_cur(cfg.mp3_start);
  return 1;
}

static avr_cycle_count_t mp3_online(avr_t *a, avr_cycle_count_t when, void *param) {
  (void)a;
  (void)when;
  (void)param;
  if (!mp3.powered || cfg.no_mp3) return 0;
  mp3.online = 1;
  ev("mp3", "ready (SD card %s)", sd_in ? "in" : "missing");
  if (sd_in) mp3_reply(0x3f, 0x0002, 0.001);
  else mp3_reply(0x40, 1, 0.001);
  return 0;
}

static void mp3_power(int on) {
  avr_cycle_timer_cancel(avr, mp3_track_end, NULL);
  avr_cycle_timer_cancel(avr, mp3_started, NULL);
  avr_cycle_timer_cancel(avr, mp3_resume_main, NULL);
  avr_cycle_timer_cancel(avr, mp3_online, NULL);
  avr_cycle_timer_cancel(avr, mp3_reply_send, NULL);
  mp3.nreply = 0;
  mp3.powered = on;
  mp3.online = 0;
  mp3.state = P_STOP;
  mp3.starting = 0;
  mp3.adv_active = 0;
  mp3.flen = 0;
  mp3.vol = 25;  // the DFPlayer's own start volume (not TNG's)
  mp3.eq = 0;
  mp3_busy(0);
  if (on && !cfg.no_mp3) avr_cycle_timer_register(avr, CYC(cfg.mp3_boot), mp3_online, NULL);
}

static void mp3_command(uint8_t cmd, int ack, uint16_t arg) {
  if (!mp3.online) return;  // still starting: nothing answers
  int err = 0;
  char name[32];
  switch (cmd) {
  case 0x01:
  case 0x02:  // next / previous: TNG does not use them
    break;
  case 0x06:
    mp3.vol = arg > 30 ? 30 : arg;
    ev("mp3", "volume %d", mp3.vol);
    break;
  case 0x04:
    if (mp3.vol < 30) mp3.vol++;
    ev("mp3", "volume %d", mp3.vol);
    break;
  case 0x05:
    if (mp3.vol > 0) mp3.vol--;
    ev("mp3", "volume %d", mp3.vol);
    break;
  case 0x07:
    mp3.eq = arg;
    ev("mp3", "eq %d", arg);
    break;
  case 0x0a:
  case 0x0b:
  case 0x1a:
    break;
  case 0x0c:
    ev("mp3", "reset");
    mp3_power(1);
    return;
  case 0x0d:
    if (mp3.state == P_PAUSE) {
      play_name(&mp3.cur, name, sizeof name);
      ev("mp3", "go on with %s", name);
      mp3_run_cur(0.02);
    }
    break;
  case 0x0e:
    if (mp3.state == P_PLAY) {
      play_name(&mp3.cur, name, sizeof name);
      mp3_halt(P_PAUSE);
      ev("mp3", "pause %s at %.1f s", name, mp3.cur.played);
    }
    break;
  case 0x0f:
    if (!mp3_play(K_FOLDER, arg >> 8, arg & 0xff)) err = 6;
    break;
  case 0x12:
    if (!mp3_play(K_MP3, 0, arg)) err = 6;
    break;
  case 0x13:
    if (mp3.state != P_PLAY || mp3.adv_active) {
      err = mp3.adv_active ? 0 : 7;  // only while a track plays
      if (mp3.adv_active) {
        mp3.cur.track = arg;
        mp3.cur.len = sound_len(K_ADV, arg);
        mp3.cur.played = 0;
        ev("mp3", "advertisement advert/%04d%s", arg, sound_text(K_ADV, arg));
        mp3_run_cur(0.03);
      }
      break;
    }
    if (sound_len(K_ADV, arg) < 0 || !sd_in) {
      err = 6;
      break;
    }
    mp3_halt(P_PLAY);
    mp3.main = mp3.cur;
    mp3.main_state = P_PLAY;
    mp3.cur = (play_t){K_ADV, 0, arg, sound_len(K_ADV, arg), 0, 0, 1000 + arg};
    mp3.adv_active = 1;
    ev("mp3", "advertisement advert/%04d%s", arg, sound_text(K_ADV, arg));
    mp3_run_cur(0.03);
    break;
  case 0x15:
    if (mp3.adv_active) {
      mp3_halt(P_STOP);
      avr_cycle_timer_register(avr, CYC(0.03), mp3_resume_main, NULL);
    }
    break;
  case 0x16:
    if (mp3.state != P_STOP || mp3.adv_active) {
      play_name(&mp3.cur, name, sizeof name);
      mp3_halt(P_STOP);
      mp3.adv_active = 0;
      ev("mp3", "stop %s", name);
    }
    break;
  case 0x42: {
    int st = mp3.state == P_PLAY ? 1 : mp3.state == P_PAUSE ? 2 : 0;
    mp3_reply(0x42, (uint16_t)(0x0200 | st), 0.01);
    break;
  }
  case 0x43: mp3_reply(0x43, (uint16_t)mp3.vol, 0.01); break;
  case 0x44: mp3_reply(0x44, (uint16_t)mp3.eq, 0.01); break;
  case 0x46: mp3_reply(0x46, 8, 0.01); break;
  case 0x48: mp3_reply(0x48, sd_in ? (uint16_t)mp3_count_total() : 0, 0.01); break;
  case 0x4c: mp3_reply(0x4c, (uint16_t)mp3.cur.index, 0.01); break;
  case 0x4e: mp3_reply(0x4e, arg < 100 && sd_in ? (uint16_t)sd_tracks[arg] : 0, 0.01); break;
  case 0x4f: {
    int n = 0;
    for (int f = 1; f < 100; f++) n += sd_tracks[f] > 0;
    mp3_reply(0x4f, (uint16_t)n, 0.01);
    break;
  }
  default:
    ev("mp3", "unknown command 0x%02x %04x", cmd, arg);
    break;
  }
  if (err) {
    ev("mp3", "error %d for command 0x%02x %04x", err, cmd, arg);
    mp3_reply(0x40, (uint16_t)err, 0.01);
  } else if (ack) mp3_reply(0x41, 0, 0.01);
}

static void mp3_rx_byte(uint8_t b) {
  if (!mp3.powered || cfg.no_mp3) return;
  if (mp3.flen == 0 && b != 0x7e) return;
  mp3.frame[mp3.flen++] = b;
  if (mp3.flen < 10) return;
  mp3.flen = 0;
  uint8_t *f = mp3.frame;
  uint16_t sum = 0;
  for (int i = 1; i < 7; i++) sum -= f[i];
  if (f[1] != 0xff || f[2] != 6 || f[9] != 0xef || ((f[7] << 8) | f[8]) != sum) {
    ev("mp3", "bad frame %02x %02x %02x %02x %02x %02x %02x %02x %02x %02x", f[0], f[1], f[2], f[3], f[4], f[5], f[6], f[7], f[8], f[9]);
    if (mp3.online) mp3_reply(0x40, 4, 0.01);  // checksum
    return;
  }
  mp3_command(f[3], f[4], (uint16_t)((f[5] << 8) | f[6]));
}

static void load_sounds(const char *file) {
  FILE *fp = fopen(file, "r");
  if (!fp) {
    fprintf(stderr, "cannot read %s\n", file);
    exit(2);
  }
  char line[512];
  while (fgets(line, sizeof line, fp)) {
    if (line[0] == '#') continue;
    char dir[16];
    int num;
    double sec;
    int used = 0;
    if (sscanf(line, "%15[^\t]\t%d\t%lf\t%n", dir, &num, &sec, &used) < 3 || num < 1 || num > 999) continue;
    sound_t *s = !strcmp(dir, "mp3") ? &sounds_mp3[num] : !strcmp(dir, "advert") ? &sounds_adv[num] : NULL;
    if (!s) continue;
    s->num = num;
    s->sec = sec;
    char *t = line + used;
    t[strcspn(t, "\r\n")] = 0;
    snprintf(s->text, sizeof s->text, "%s", t);
  }
  fclose(fp);
  sounds_loaded = 1;
}

// ------------------------------------------------------------------ MFRC522 and the cards

enum { C_NONE, C_CLASSIC, C_UL, C_NTAG213, C_NTAG215, C_NTAG216 };
enum { S_OFF, S_IDLE, S_READY, S_ACTIVE, S_HALT };

typedef struct {
  int used, type;
  uint8_t uid[7];
  int uidlen;
  uint8_t mem[1024];  // Classic: 64 blocks of 16; UL/NTAG: pages of 4
  int pages;
  double flaky;
  int readonly;
} card_t;

static card_t cards[16];
static card_t *on_reader;
static int card_state;   // S_*
static int card_level;   // cascade level reached in READY
static int auth_sector = -1;
static int write_block = -1;  // Classic: a WRITE waits for its 16 bytes

static uint16_t crc_a(const uint8_t *d, int n) {
  uint16_t crc = 0x6363;
  for (int i = 0; i < n; i++) {
    uint8_t b = d[i] ^ (uint8_t)(crc & 0xff);
    b ^= (uint8_t)(b << 4);
    crc = (uint16_t)((crc >> 8) ^ ((uint16_t)b << 8) ^ ((uint16_t)b << 3) ^ (b >> 4));
  }
  return crc;
}
static int crc_ok(const uint8_t *d, int n) {
  if (n < 3) return 0;
  uint16_t c = crc_a(d, n - 2);
  return d[n - 2] == (c & 0xff) && d[n - 1] == (c >> 8);
}
static int add_crc(uint8_t *d, int n) {
  uint16_t c = crc_a(d, n);
  d[n] = c & 0xff;
  d[n + 1] = c >> 8;
  return n + 2;
}

static const char *type_name(int t) {
  switch (t) {
  case C_CLASSIC: return "classic";
  case C_UL: return "ultralight";
  case C_NTAG213: return "ntag213";
  case C_NTAG215: return "ntag215";
  case C_NTAG216: return "ntag216";
  }
  return "?";
}

static void card_init_mem(card_t *c) {
  memset(c->mem, 0, sizeof c->mem);
  if (c->type == C_CLASSIC) {
    memcpy(c->mem, c->uid, 4);
    c->mem[4] = c->uid[0] ^ c->uid[1] ^ c->uid[2] ^ c->uid[3];
    c->mem[5] = 0x08; c->mem[6] = 0x04; c->mem[7] = 0x00;
    for (int s = 0; s < 16; s++) {
      uint8_t *t = c->mem + (s * 4 + 3) * 16;
      memset(t, 0xff, 6);
      t[6] = 0xff; t[7] = 0x07; t[8] = 0x80; t[9] = 0x69;
      memset(t + 10, 0xff, 6);
    }
  } else {
    c->pages = c->type == C_UL ? 16 : c->type == C_NTAG213 ? 45 : c->type == C_NTAG215 ? 135 : 231;
    uint8_t *m = c->mem;
    m[0] = c->uid[0]; m[1] = c->uid[1]; m[2] = c->uid[2]; m[3] = 0x88 ^ c->uid[0] ^ c->uid[1] ^ c->uid[2];
    m[4] = c->uid[3]; m[5] = c->uid[4]; m[6] = c->uid[5]; m[7] = c->uid[6];
    m[8] = c->uid[3] ^ c->uid[4] ^ c->uid[5] ^ c->uid[6];
    if (c->type != C_UL) {
      m[12] = 0xe1; m[13] = 0x10;
      m[14] = c->type == C_NTAG213 ? 0x12 : c->type == C_NTAG215 ? 0x3e : 0x6d;
    }
  }
}

static uint8_t *card_data(card_t *c) { return c->type == C_CLASSIC ? c->mem + 4 * 16 : c->mem + 8 * 4; }

static void print_card(card_t *c, const char *what) {
  uint8_t *d = card_data(c);
  char uid[32] = "";
  for (int i = 0; i < c->uidlen; i++) sprintf(uid + 2 * i, "%02x", c->uid[i]);
  evw("rfid", "%s %s %s: %02x %02x %02x %02x %02x %02x %02x %02x %02x %02x %02x %02x %02x %02x %02x %02x", what, type_name(c->type), uid,
      d[0], d[1], d[2], d[3], d[4], d[5], d[6], d[7], d[8], d[9], d[10], d[11], d[12], d[13], d[14], d[15]);
}

static int chance(double p) { return p > 0 && (double)rand() / RAND_MAX < p; }

// One frame from the reader to the card. Returns the answer's length and its valid bits in the
// last byte (0 = all eight), or -1 for no answer.
static int card_frame(const uint8_t *in, int n, int lastbits, uint8_t *out, int *outbits) {
  card_t *c = on_reader;
  *outbits = 0;
  if (!c || card_state == S_OFF) return -1;
  if (chance(c->flaky)) return -1;
  int classic = c->type == C_CLASSIC;
  // REQA / WUPA: 7-bit short frames
  if (n == 1 && lastbits == 7 && (in[0] == 0x26 || in[0] == 0x52)) {
    if (card_state == S_IDLE || (in[0] == 0x52 && card_state == S_HALT)) {
      card_state = S_READY;
      card_level = 1;
      auth_sector = -1;
      write_block = -1;
      out[0] = classic ? 0x04 : 0x44;
      out[1] = 0x00;
      return 2;
    }
    if (cfg.reqa_answers && card_state != S_HALT) {
      card_state = S_IDLE;
      return card_frame(in, n, lastbits, out, outbits);
    }
    if (card_state != S_HALT) card_state = S_IDLE;  // a request in the middle is no command it knows
    return -1;
  }
  if (card_state == S_READY && n >= 2 && (in[0] == 0x93 || in[0] == 0x95)) {
    int level = in[0] == 0x93 ? 1 : 2;
    uint8_t part[4];
    if (c->uidlen == 4) memcpy(part, c->uid, 4);
    else if (level == 1) {
      part[0] = 0x88;
      memcpy(part + 1, c->uid, 3);
    } else memcpy(part, c->uid + 3, 4);
    if (level == 2 && c->uidlen == 4) {
      card_state = S_IDLE;
      return -1;
    }
    if (in[1] == 0x20) {  // ANTICOLLISION
      memcpy(out, part, 4);
      out[4] = part[0] ^ part[1] ^ part[2] ^ part[3];
      return 5;
    }
    if (in[1] == 0x70 && n == 9 && crc_ok(in, 9) && !memcmp(in + 2, part, 4)) {  // SELECT
      int complete = c->uidlen == 4 || level == 2;
      out[0] = complete ? (classic ? 0x08 : 0x00) : 0x04;
      if (complete) card_state = S_ACTIVE;
      return add_crc(out, 1);
    }
    card_state = S_IDLE;
    return -1;
  }
  if (card_state != S_ACTIVE) {
    if (card_state != S_HALT) card_state = S_IDLE;
    return -1;
  }
  // ACTIVE
  if (write_block >= 0) {  // second part of a Classic WRITE: 16 bytes and CRC
    int blk = write_block;
    write_block = -1;
    if (n != 18 || !crc_ok(in, 18)) {
      card_state = S_IDLE;
      return -1;
    }
    if (c->readonly) {
      out[0] = 0x04;
      *outbits = 4;
      return 1;
    }
    memcpy(c->mem + blk * 16, in, 16);
    if (blk == 4) print_card(c, "written");
    out[0] = 0x0a;
    *outbits = 4;
    return 1;
  }
  if (n == 4 && in[0] == 0x50 && in[1] == 0x00) {  // HLTA
    card_state = S_HALT;
    return -1;
  }
  if (n == 4 && in[0] == 0x30 && crc_ok(in, 4)) {  // READ
    int blk = in[1];
    if (classic) {
      if (blk >= 64 || auth_sector != blk / 4) {
        out[0] = 0x04;
        *outbits = 4;
        card_state = S_IDLE;
        return 1;
      }
      memcpy(out, c->mem + blk * 16, 16);
      if (blk % 4 == 3) memset(out, 0, 6);  // key A never reads back
    } else {
      if (blk >= c->pages) {
        out[0] = 0x00;
        *outbits = 4;
        card_state = S_IDLE;
        return 1;
      }
      for (int i = 0; i < 16; i++) out[i] = c->mem[((blk + i / 4) % c->pages) * 4 + i % 4];
    }
    return add_crc(out, 16);
  }
  if (n == 4 && in[0] == 0xa0 && crc_ok(in, 4)) {  // WRITE, first part
    int blk = in[1];
    if (!classic || blk >= 64 || blk == 0 || auth_sector != blk / 4) {
      out[0] = 0x04;
      *outbits = 4;
      card_state = S_IDLE;
      return 1;
    }
    write_block = blk;
    out[0] = 0x0a;
    *outbits = 4;
    return 1;
  }
  if (n == 8 && in[0] == 0xa2 && crc_ok(in, 8) && !classic) {  // Ultralight WRITE
    int page = in[1];
    if (page < 4 || page >= c->pages || c->readonly) {
      out[0] = 0x00;
      *outbits = 4;
      return 1;
    }
    memcpy(c->mem + page * 4, in + 2, 4);
    if (page == 11) print_card(c, "written");
    out[0] = 0x0a;
    *outbits = 4;
    return 1;
  }
  card_state = S_IDLE;  // anything else (a plain frame while Crypto1 runs, too)
  return -1;
}

// MIFARE Classic authentication (MFAuthent): 1 = ok.
static int card_auth(const uint8_t *in, int n) {
  card_t *c = on_reader;
  if (!c || card_state != S_ACTIVE || c->type != C_CLASSIC || n < 12 || chance(c->flaky)) {
    if (c && card_state != S_HALT && card_state != S_OFF) card_state = S_IDLE;
    return 0;
  }
  int blk = in[1];
  if (blk >= 64 || (in[0] != 0x60 && in[0] != 0x61) || memcmp(in + 8, c->uid, 4)) {
    card_state = S_IDLE;
    return 0;
  }
  const uint8_t *trailer = c->mem + ((blk / 4) * 4 + 3) * 16;
  if (memcmp(in + 2, in[0] == 0x60 ? trailer : trailer + 10, 6)) {
    card_state = S_IDLE;
    return 0;
  }
  auth_sector = blk / 4;
  return 1;
}

// Registers by their number (datasheet section 9).
enum {
  R_Command = 0x01, R_ComIrq = 0x04, R_DivIrq = 0x05, R_Error = 0x06, R_Status2 = 0x08,
  R_FIFOData = 0x09, R_FIFOLevel = 0x0a, R_Control = 0x0c, R_BitFraming = 0x0d, R_Coll = 0x0e,
  R_Mode = 0x11, R_TxControl = 0x14, R_CRCResultH = 0x21, R_CRCResultL = 0x22,
  R_TMode = 0x2a, R_TPrescaler = 0x2b, R_TReloadH = 0x2c, R_TReloadL = 0x2d, R_Version = 0x37,
};

static struct {
  uint8_t reg[64];
  uint8_t fifo[64];
  int fifo_n, fifo_rd;
  int cs_low, first, addr, reading;
  uint8_t answer[64];
  int answer_n, answer_bits, answer_ok;
} rc;

static void rc_defaults(void) {
  memset(rc.reg, 0, sizeof rc.reg);
  rc.reg[R_Command] = 0x20;
  rc.reg[R_ComIrq] = 0x14;
  rc.reg[R_Coll] = 0x80;
  rc.reg[R_Mode] = 0x3f;
  rc.reg[R_TxControl] = 0x80;
  rc.reg[R_Version] = (uint8_t)cfg.rfid_version;
  rc.fifo_n = rc.fifo_rd = 0;
}

static int antenna_on(void) { return (rc.reg[R_TxControl] & 0x03) == 0x03; }

static void field_changed(void) {
  if (!antenna_on() || !on_reader) card_state = S_OFF;
  else if (card_state == S_OFF) card_state = S_IDLE;
}

// The reader's timer: what it waits before it gives up on an answer (25 ms as TNG sets it up).
static double rc_timeout(void) {
  int pre = ((rc.reg[R_TMode] & 0x0f) << 8) | rc.reg[R_TPrescaler];
  int reload = (rc.reg[R_TReloadH] << 8) | rc.reg[R_TReloadL];
  double t = (reload + 1.0) * (2.0 * pre + 1.0) / 13.56e6;
  return t > 0 && t < 1 ? t : 0.025;
}

static avr_cycle_count_t rc_done(avr_t *a, avr_cycle_count_t when, void *param) {
  (void)a;
  (void)when;
  (void)param;
  if (rc.answer_ok) {
    memcpy(rc.fifo, rc.answer, (size_t)rc.answer_n);
    rc.fifo_n = rc.answer_n;
    rc.fifo_rd = 0;
    rc.reg[R_Control] = (uint8_t)((rc.reg[R_Control] & ~7) | (rc.answer_bits & 7));
    rc.reg[R_Error] = 0;
    rc.reg[R_ComIrq] |= 0x30 | 0x40;  // RxIRq, IdleIRq, TxIRq
  } else rc.reg[R_ComIrq] |= 0x01 | 0x40;  // TimerIRq: nothing came back
  return 0;
}
static avr_cycle_count_t rc_auth_done(avr_t *a, avr_cycle_count_t when, void *param) {
  (void)a;
  (void)when;
  (void)param;
  if (rc.answer_ok) {
    rc.reg[R_Status2] |= 0x08;
    rc.reg[R_ComIrq] |= 0x10;
  } else rc.reg[R_ComIrq] |= 0x01;
  return 0;
}

static void rc_transceive(void) {
  int lastbits = rc.reg[R_BitFraming] & 7;
  uint8_t in[64];
  int n = rc.fifo_n - rc.fifo_rd;
  memcpy(in, rc.fifo + rc.fifo_rd, (size_t)(n > 0 ? n : 0));
  rc.fifo_n = rc.fifo_rd = 0;
  int bits = 0;
  int got = antenna_on() ? card_frame(in, n, lastbits, rc.answer, &bits) : -1;
  rc.answer_ok = got >= 0;
  rc.answer_n = got > 0 ? got : 0;
  rc.answer_bits = bits;
  // Air time at 106 kbit/s (about 9.4 us per bit with parity) plus the card's answer time.
  double t = rc.answer_ok ? 0.0001 + (n + rc.answer_n) * 9 * 9.44e-6 : rc_timeout();
  avr_cycle_timer_cancel(avr, rc_done, NULL);
  avr_cycle_timer_register(avr, CYC(t), rc_done, NULL);
}

static void rc_command(uint8_t v) {
  rc.reg[R_Command] = v & 0x3f;
  avr_cycle_timer_cancel(avr, rc_done, NULL);
  avr_cycle_timer_cancel(avr, rc_auth_done, NULL);
  switch (v & 0x0f) {
  case 0x0f:  // SoftReset
    rc_defaults();
    field_changed();
    break;
  case 0x03: {  // CalcCRC
    uint16_t c = crc_a(rc.fifo + rc.fifo_rd, rc.fifo_n - rc.fifo_rd);
    rc.reg[R_CRCResultL] = c & 0xff;
    rc.reg[R_CRCResultH] = c >> 8;
    rc.reg[R_DivIrq] |= 0x04;
    break;
  }
  case 0x0e: {  // MFAuthent
    uint8_t in[64];
    int n = rc.fifo_n - rc.fifo_rd;
    memcpy(in, rc.fifo + rc.fifo_rd, (size_t)n);
    rc.fifo_n = rc.fifo_rd = 0;
    rc.answer_ok = antenna_on() && card_auth(in, n);
    avr_cycle_timer_register(avr, CYC(rc.answer_ok ? 0.0012 : rc_timeout()), rc_auth_done, NULL);
    break;
  }
  default:  // Idle, Transceive (waits for StartSend), others
    break;
  }
}

static void rc_write(int reg, uint8_t v) {
  switch (reg) {
  case R_Command: rc_command(v); return;
  case R_ComIrq:
  case R_DivIrq:
    if (v & 0x80) rc.reg[reg] |= v & 0x7f;
    else rc.reg[reg] &= (uint8_t)~(v & 0x7f);
    return;
  case R_FIFOData:
    if (rc.fifo_n < 64) rc.fifo[rc.fifo_n++] = v;
    return;
  case R_FIFOLevel:
    if (v & 0x80) rc.fifo_n = rc.fifo_rd = 0;
    return;
  case R_BitFraming:
    rc.reg[reg] = v & 0x7f;
    if ((v & 0x80) && (rc.reg[R_Command] & 0x0f) == 0x0c) rc_transceive();
    return;
  case R_TxControl:
    rc.reg[reg] = v;
    field_changed();
    return;
  case R_Version:
    return;
  default:
    rc.reg[reg] = v;
  }
}

static uint8_t rc_read(int reg) {
  switch (reg) {
  case R_FIFOData: return rc.fifo_rd < rc.fifo_n ? rc.fifo[rc.fifo_rd++] : 0;
  case R_FIFOLevel: return (uint8_t)(rc.fifo_n - rc.fifo_rd);
  case R_BitFraming: return rc.reg[reg] & 0x7f;
  }
  return rc.reg[reg];
}

static void spi_byte(struct avr_irq_t *irq, uint32_t value, void *param) {
  (void)irq;
  (void)param;
  uint8_t miso = 0;
  if (rc.cs_low && !cfg.no_rfid) {
    if (rc.first) {
      rc.first = 0;
      rc.addr = (value >> 1) & 0x3f;
      rc.reading = (value & 0x80) != 0;
    } else if (rc.reading) {
      miso = rc_read(rc.addr);
      rc.addr = (value >> 1) & 0x3f;  // the next address to read, or 0 to stop
    } else rc_write(rc.addr, (uint8_t)value);
  }
  avr_raise_irq(avr_io_getirq(avr, AVR_IOCTL_SPI_GETIRQ(0), SPI_IRQ_INPUT), miso);
}
static void rc_cs(struct avr_irq_t *irq, uint32_t value, void *param) {
  (void)irq;
  (void)param;
  rc.cs_low = !value;
  rc.first = 1;
}

// LGT8F328P (AiO): its SPI waits on the FIFO flag RDEMPT of SPFR (0x39, lgt8fx lgtx8p.h), which the
// ATmega328P has not. Empty until the byte is through, as SPIF (SPSR 0x4d bit 7) says.
static uint8_t lgt_spfr_read(struct avr_t *a, avr_io_addr_t addr, void *param) {
  (void)addr;
  (void)param;
  return (a->data[0x4d] & 0x80) ? 0x04 : 0x44;  // WREMPT, plus RDEMPT while nothing came back
}

static card_t *card_by_uid(const uint8_t *uid, int len) {
  for (int i = 0; i < 16; i++)
    if (cards[i].used && cards[i].uidlen == len && !memcmp(cards[i].uid, uid, (size_t)len)) return &cards[i];
  return NULL;
}

static int hexbytes(const char *s, uint8_t *out, int max) {
  int n = 0;
  while (*s && n < max) {
    while (*s && !isxdigit((unsigned char)*s)) s++;
    if (!s[0] || !s[1]) break;
    unsigned v;
    if (sscanf(s, "%2x", &v) != 1) break;
    out[n++] = (uint8_t)v;
    s += 2;
  }
  return n;
}

// "card TYPE [uid=..] [data=..] [tonuino=..] [key=..] [flaky=..] [readonly]" or "card off"
static const char *cmd_card(char *args) {
  char *tok = strtok(args, " \t");
  if (!tok) return "card: what?";
  if (!strcmp(tok, "off")) {
    if (on_reader) evw("rfid", "card off");
    on_reader = NULL;
    card_state = S_OFF;
    auth_sector = -1;
    write_block = -1;
    return NULL;
  }
  int type = !strcmp(tok, "classic") ? C_CLASSIC : !strcmp(tok, "ultralight") ? C_UL : !strcmp(tok, "ntag213") ? C_NTAG213
           : !strcmp(tok, "ntag215") ? C_NTAG215 : !strcmp(tok, "ntag216") ? C_NTAG216 : C_NONE;
  if (type == C_NONE) return "card: unknown type";
  uint8_t uid[7];
  int uidlen = type == C_CLASSIC ? 4 : 7;
  static unsigned next_uid = 0x10;
  for (int i = 0; i < uidlen; i++) uid[i] = (uint8_t)(i == 0 && uidlen == 7 ? 0x04 : 0xa0 + i);
  uid[uidlen - 1] = (uint8_t)next_uid++;
  uint8_t data[16];
  int ndata = -1;
  uint8_t key[6];
  int haskey = 0;
  double flaky = 0;
  int readonly = 0;
  while ((tok = strtok(NULL, " \t"))) {
    if (!strncmp(tok, "uid=", 4)) {
      int n = hexbytes(tok + 4, uid, 7);
      if (n != uidlen || strlen(tok + 4) != 2 * (size_t)uidlen) return "card: uid needs 4 bytes (classic) or 7";
    } else if (!strncmp(tok, "data=", 5)) {
      memset(data, 0, sizeof data);
      ndata = hexbytes(tok + 5, data, 16);
    } else if (!strncmp(tok, "tonuino=", 8)) {
      int v[4] = {0, 0, 0, 0};
      sscanf(tok + 8, "%d,%d,%d,%d", &v[0], &v[1], &v[2], &v[3]);
      memset(data, 0, sizeof data);
      uint8_t head[9] = {0x13, 0x37, 0xb3, 0x47, 0x02, (uint8_t)v[0], (uint8_t)v[1], (uint8_t)v[2], (uint8_t)v[3]};
      memcpy(data, head, 9);
      ndata = 16;
    } else if (!strncmp(tok, "key=", 4)) {
      haskey = hexbytes(tok + 4, key, 6) == 6;
    } else if (!strncmp(tok, "flaky=", 6)) {
      flaky = atof(tok + 6);
    } else if (!strcmp(tok, "readonly")) {
      readonly = 1;
    } else return "card: unknown option";
  }
  card_t *c = card_by_uid(uid, uidlen);
  if (!c) {
    for (int i = 0; i < 16 && !c; i++)
      if (!cards[i].used) c = &cards[i];
    if (!c) c = &cards[15];
    memset(c, 0, sizeof *c);
    c->used = 1;
    c->type = type;
    memcpy(c->uid, uid, (size_t)uidlen);
    c->uidlen = uidlen;
    card_init_mem(c);
  }
  if (c->type != type) return "card: this uid is a card of another type";
  if (ndata >= 0) memcpy(card_data(c), data, 16);
  if (haskey && type == C_CLASSIC)
    for (int s = 0; s < 16; s++) memcpy(c->mem + (s * 4 + 3) * 16, key, 6);
  c->flaky = flaky;
  c->readonly = readonly;
  on_reader = c;
  card_state = S_OFF;
  auth_sector = -1;
  write_block = -1;
  field_changed();
  print_card(c, "card on");
  return NULL;
}

// ------------------------------------------------------------------ keys, knobs, headphones

typedef struct {
  const char *name;
  char port;
  int bit;
} keypin_t;

static int key_pin(const char *name, char *port, int *bit) {
  // TNG constants.hpp: Classic 3 keys A0 A1 A2; Classic 5 keys pause A0, up A3, down A4, four A1,
  // five A2; AiO up A2, down A1, four A4, five A3.
  int five = cfg.buttons == 5;
  struct { const char *n; int classic3, classic5, aio; } map[] = {
    {"pause", 0, 0, 0}, {"up", 1, 3, 2}, {"down", 2, 4, 1}, {"four", -1, 1, 4}, {"five", -1, 2, 3},
  };
  for (unsigned i = 0; i < sizeof map / sizeof map[0]; i++) {
    if (strcmp(name, map[i].n)) continue;
    int b = cfg.aio ? (i >= 3 && !five ? -1 : map[i].aio) : five ? map[i].classic5 : map[i].classic3;
    if (b < 0) return 0;
    *port = 'C';
    *bit = b;
    return 1;
  }
  return 0;
}

static int keys_down[5];
static const char *KEY_NAMES[5] = {"pause", "up", "down", "four", "five"};

static const char *set_keys(char *list, int down) {
  char copy[128];
  snprintf(copy, sizeof copy, "%s", list);
  for (char *k = strtok(copy, "+"); k; k = strtok(NULL, "+")) {
    if (!strcmp(k, "all")) {
      for (int i = 0; i < 5; i++) {
        char p;
        int b;
        if (keys_down[i] && key_pin(KEY_NAMES[i], &p, &b)) pin_set(p, b, 1);
        keys_down[i] = 0;
      }
      continue;
    }
    int idx = -1;
    for (int i = 0; i < 5; i++)
      if (!strcmp(k, KEY_NAMES[i])) idx = i;
    char p;
    int b;
    if (idx < 0 || !key_pin(k, &p, &b)) return "no such key on this box";
    keys_down[idx] = down;
    pin_set(p, b, !down);  // active low
  }
  return NULL;
}

static int poti_mv = 2500;
static void poti_apply(void) { avr_raise_irq(avr_io_getirq(avr, AVR_IOCTL_ADC_GETIRQ, ADC_IRQ_ADC3), (uint32_t)poti_mv); }

// ------------------------------------------------------------------ the AVR

static uint8_t *flash_image;
static uint32_t flash_size;
static uint8_t eeprom_save[1024];

static void eeprom_get(uint8_t *buf) {
  avr_eeprom_desc_t d = {buf, 0, 1024};
  avr_ioctl(avr, AVR_IOCTL_EEPROM_GET, &d);
}
static void eeprom_set(uint8_t *buf) {
  avr_eeprom_desc_t d = {buf, 0, 1024};
  avr_ioctl(avr, AVR_IOCTL_EEPROM_SET, &d);
}

static void outside_levels(void) {
  // Keys (pull-ups: high when not pressed), encoder at rest, busy pin, serial line idle, reader's reset pin.
  for (int i = 0; i < 5; i++) {
    char p;
    int b;
    if (key_pin(KEY_NAMES[i], &p, &b)) pin_set(p, b, !keys_down[i]);
  }
  if (cfg.buttons == 3 || cfg.buttons == 0) {
    pin_set('C', 3, 1);
    pin_set('C', 4, 1);
  }
  pin_set('D', 2, 1);
  pin_set('D', 4, mp3.state == P_PLAY && !mp3.starting ? 0 : 1);
  pin_set('B', 1, 1);
  poti_apply();
  avr_raise_irq(avr_io_getirq(avr, AVR_IOCTL_ADC_GETIRQ, ADC_IRQ_ADC7), 1234);
  avr_raise_irq(avr_io_getirq(avr, AVR_IOCTL_ADC_GETIRQ, ADC_IRQ_ADC5), (uint32_t)cfg.bat_pin_mv);
}

static int hp_in;
static void hp_apply(void) { pin_set('B', 0, hp_in); }

static void sleep_none(avr_t *a, avr_cycle_count_t howLong) {
  (void)a;
  (void)howLong;
}

// simavr's reset drops every cycle timer, also those of the MP3 player and the card reader,
// which do not restart with the microcontroller: they are put back afterwards.
static avr_cycle_timer_t outside_timers[] = {enc_step, mp3_reply_send, mp3_track_end, mp3_started, mp3_resume_main, mp3_online, rc_done, rc_auth_done};
#define N_OUTSIDE (sizeof outside_timers / sizeof outside_timers[0])

static void mcu_reset(const char *why) {
  avr_cycle_count_t left[N_OUTSIDE];
  for (unsigned i = 0; i < N_OUTSIDE; i++) left[i] = avr_cycle_timer_status(avr, outside_timers[i], NULL);
  avr_cycle_count_t cycle = avr->cycle;
  eeprom_get(eeprom_save);
  avr_reset(avr);
  avr->cycle = cycle;
  eeprom_set(eeprom_save);
  for (unsigned i = 0; i < N_OUTSIDE; i++)
    if (left[i]) avr_cycle_timer_register(avr, left[i], outside_timers[i], NULL);
  // The reset clears the PIN registers, but not simavr's memory of the levels: raise every level
  // from outside again, once the other way round so it is not filtered as unchanged.
  for (int i = 0; i < 3; i++)
    for (int b = 0; b < 8; b++)
      if (ext_mask[i] & (1 << b)) {
        int level = (ext_value[i] >> b) & 1;
        avr_raise_irq(pin_irq((char)('B' + i), b), !level);
        avr_raise_irq(pin_irq((char)('B' + i), b), level);
      }
  memset(avr->data + 0x100, 0, 2048);  // SRAM content is undefined after power-on; zero it to be reproducible
  avr->pc = 0;
  ulen = 0;
  enc_phase = 0;
  to_head = to_tail = 0;
  dec_active = 0;
  rc.cs_low = 0;
  outside_levels();
  hp_apply();
  ev("sim", "%s", why);
}

static int box_on = 1;

static void step(avr_cycle_count_t until) {
  while (avr->cycle < until) {
    if (!box_on || avr->state == cpu_Done || avr->state == cpu_Crashed) {
      // Switched off (or the firmware put itself to sleep for good): time goes on for the peripherals.
      avr_cycle_count_t next = avr->cycle + CYC(0.001);
      avr->cycle = next < until ? next : until;
      avr_cycle_timer_process(avr);
      continue;
    }
    int st = avr_run(avr);
    if (st == cpu_Done) ev("sim", "the box switched itself off");
    if (st == cpu_Crashed) ev("sim", "the firmware crashed (pc 0x%04x)", avr->pc);
  }
}

static double wall0;
static double wall_now(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return ts.tv_sec + ts.tv_nsec / 1e9;
}

// ------------------------------------------------------------------ commands

static char pending[64][600];
static int pend_head, pend_tail;
static int cmd_no;

static int read_stdin(int block) {
  static char buf[8192];
  static int blen;
  static int eof;
  if (eof) return pend_head != pend_tail ? 1 : -1;
  struct pollfd p = {0, POLLIN, 0};
  int r = poll(&p, 1, block ? -1 : 0);
  if (r > 0) {
    int n = (int)read(0, buf + blen, sizeof buf - 1 - blen);
    if (n <= 0) eof = 1;
    else blen += n;
    char *nl;
    while ((nl = memchr(buf, '\n', (size_t)blen))) {
      *nl = 0;
      int next = (pend_head + 1) % 64;
      if (next != pend_tail) {
        snprintf(pending[pend_head], sizeof pending[0], "%.599s", buf);
        pend_head = next;
      }
      int used = (int)(nl - buf) + 1;
      memmove(buf, nl + 1, (size_t)(blen - used));
      blen -= used;
    }
    if (eof && blen) {
      buf[blen] = 0;
      snprintf(pending[pend_head], sizeof pending[0], "%.599s", buf);
      pend_head = (pend_head + 1) % 64;
      blen = 0;
    }
  }
  return eof && pend_head == pend_tail ? -1 : pend_head != pend_tail;
}

// Lets simulated time pass; in real-time mode it waits for the clock and reads new commands meanwhile.
static void advance(double sec) {
  avr_cycle_count_t end = avr->cycle + CYC(sec);
  while (avr->cycle < end) {
    avr_cycle_count_t slice = avr->cycle + CYC(0.002);
    step(slice < end ? slice : end);
    if (cfg.realtime > 0) {
      read_stdin(0);
      double ahead = now() / cfg.realtime - (wall_now() - wall0);
      if (ahead > 0.002) {
        struct timespec ts = {0, (long)(ahead * 1e9)};
        nanosleep(&ts, NULL);
      }
    }
    if (watch_hit) return;
  }
}

static double press_ms(const char *how) {
  if (!how || !*how || !strcmp(how, "short")) return 150;
  if (!strcmp(how, "long")) return 1500;
  return atof(how);
}

static const char *run_command(char *line) {
  char *cmd = strtok(line, " \t");
  char *rest = strtok(NULL, "");
  if (rest) while (*rest == ' ' || *rest == '\t') rest++;
  // "until" also looks at what the command just before it caused, nothing older.
  if (strcmp(cmd, "until")) hist_n = 0;
  if (!strcmp(cmd, "wait")) {
    advance(rest ? atof(rest) : 1);
    return NULL;
  }
  if (!strcmp(cmd, "until")) {
    if (!rest) return "until: what?";
    double limit = 30;
    char *sp = strrchr(rest, ' ');
    if (sp && sp[1] && strspn(sp + 1, "0123456789.") == strlen(sp + 1)) {
      limit = atof(sp + 1);
      *sp = 0;
    }
    if (history_find(rest)) return NULL;
    hist_n = 0;
    snprintf(watch_text, sizeof watch_text, "%s", rest);
    watch_hit = 0;
    advance(limit);
    int hit = watch_hit;
    watch_text[0] = 0;
    watch_hit = 0;
    return hit ? NULL : "timeout";
  }
  if (!strcmp(cmd, "press")) {
    if (!rest) return "press: which keys?";
    char *how = strchr(rest, ' ');
    if (how) *how++ = 0;
    double ms = press_ms(how);
    const char *err = set_keys(rest, 1);
    if (err) return err;
    ev("key", "press %s %.0f ms", rest, ms);
    advance(ms / 1000);
    set_keys(rest, 0);
    advance(0.1);
    return NULL;
  }
  if (!strcmp(cmd, "hold") || !strcmp(cmd, "release")) {
    if (!rest) return "which keys?";
    const char *err = set_keys(rest, cmd[0] == 'h');
    if (!err) ev("key", "%s %s", cmd, rest);
    return err;
  }
  if (!strcmp(cmd, "turn")) {
    int right = rest && !strncmp(rest, "right", 5);
    int n = rest && strchr(rest, ' ') ? atoi(strchr(rest, ' ')) : 1;
    for (int i = 0; i < n; i++) {
      ev("key", "turn %s", right ? "right" : "left");
      pin_set('C', 4, right);  // DT
      advance(0.005);
      pin_set('C', 3, 0);  // CLK
      advance(0.02);
      pin_set('C', 3, 1);
      pin_set('C', 4, 1);
      advance(0.2);
    }
    return NULL;
  }
  if (!strcmp(cmd, "poti")) {
    poti_mv = (int)((rest ? atof(rest) : 50) * 50);
    poti_apply();
    ev("key", "poti %d mV", poti_mv);
    return NULL;
  }
  if (!strcmp(cmd, "hp")) {
    hp_in = rest && !strcmp(rest, "in");
    hp_apply();
    ev("key", "headphones %s", hp_in ? "in" : "out");
    return NULL;
  }
  if (!strcmp(cmd, "card")) return cmd_card(rest ? rest : (char *)"");
  if (!strcmp(cmd, "cards")) {
    for (int i = 0; i < 16; i++)
      if (cards[i].used) print_card(&cards[i], &cards[i] == on_reader ? "on reader" : "known");
    return NULL;
  }
  if (!strcmp(cmd, "serial")) {
    char buf[600];
    int n = snprintf(buf, sizeof buf, "%s\n", rest ? rest : "");
    host_send((uint8_t *)buf, n);
    return NULL;
  }
  if (!strcmp(cmd, "tx")) {
    uint8_t buf[600];
    int n = hexbytes(rest ? rest : "", buf, sizeof buf);
    host_send(buf, n);
    return NULL;
  }
  if (!strcmp(cmd, "reset")) {
    if (box_on) mcu_reset("reset over DTR");
    return NULL;
  }
  if (!strcmp(cmd, "power")) {
    int off = rest && (!strcmp(rest, "off") || !strcmp(rest, "cycle"));
    int on = !rest || !strcmp(rest, "on") || !strcmp(rest, "cycle");
    if (off) {
      box_on = 0;
      mp3_power(0);
      rc_defaults();
      card_state = S_OFF;
      avr_cycle_timer_cancel(avr, rc_done, NULL);
      avr_cycle_timer_cancel(avr, rc_auth_done, NULL);
      ev("sim", "power off");
      advance(0.2);
    }
    if (on) {
      box_on = 1;
      rc_defaults();
      mcu_reset("power on");
      mp3_power(1);
    }
    return NULL;
  }
  if (!strcmp(cmd, "mp3")) {
    if (rest && !strncmp(rest, "error ", 6)) {
      mp3_reply(0x40, (uint16_t)atoi(rest + 6), 0.001);
      ev("mp3", "reports error %d", atoi(rest + 6));
      return NULL;
    }
    return "mp3: error N";
  }
  if (!strcmp(cmd, "sd")) {
    int in = rest && !strcmp(rest, "in");
    if (in == sd_in) return NULL;
    sd_in = in;
    if (!in && mp3.state != P_STOP) mp3_halt(P_STOP);
    ev("mp3", "SD card %s", in ? "in" : "pulled");
    if (mp3.online) mp3_reply(in ? 0x3a : 0x3b, 0x0002, 0.05);
    return NULL;
  }
  if (!strcmp(cmd, "eeprom")) {
    uint8_t buf[1024];
    eeprom_get(buf);
    if (rest && *rest) {
      FILE *fp = fopen(rest, "wb");
      if (!fp || fwrite(buf, 1, 1024, fp) != 1024) return "eeprom: cannot write";
      fclose(fp);
      return NULL;
    }
    // TNG keeps its settings at address 0 (settings.cpp)
    char hex[3 * 40 + 1] = "";
    for (int i = 0; i < 40; i++) sprintf(hex + 3 * i, "%02x ", buf[i]);
    ev("sim", "eeprom %s", hex);
    return NULL;
  }
  if (!strcmp(cmd, "quit")) return "quit";
  return "unknown command";
}

static void usage(void) {
  fprintf(stderr, "usage: boxsim [options] firmware.bin|.hex < script (see the top of boxsim.c)\n");
  exit(2);
}

static void parse_sd(const char *spec) {
  memset(sd_tracks, 0, sizeof sd_tracks);
  char copy[1024];
  snprintf(copy, sizeof copy, "%s", spec);
  for (char *t = strtok(copy, ","); t; t = strtok(NULL, ",")) {
    int f, n;
    if (sscanf(t, "%d:%d", &f, &n) == 2 && f >= 1 && f <= 99 && n >= 0 && n <= 255) sd_tracks[f] = n;
  }
}

int main(int argc, char **argv) {
  setvbuf(stdout, NULL, _IOLBF, 0);
  const char *firmware = NULL;
  parse_sd("1:10,2:10,3:10,4:10,5:10");
  for (int i = 1; i < argc; i++) {
    const char *a = argv[i];
    const char *v = i + 1 < argc ? argv[i + 1] : NULL;
    if (!strcmp(a, "--buttons") && v) {
      cfg.buttons = !strcmp(v, "3x3") ? 9 : atoi(v);
      i++;
    } else if (!strcmp(a, "--board") && v) {
      cfg.aio = !strcmp(v, "aio");
      i++;
    } else if (!strcmp(a, "--sd") && v) {
      parse_sd(v);
      i++;
    } else if (!strcmp(a, "--track-seconds") && v) {
      cfg.track_seconds = atof(v);
      i++;
    } else if (!strcmp(a, "--sounds") && v) {
      load_sounds(v);
      i++;
    } else if (!strcmp(a, "--mp3-boot") && v) {
      cfg.mp3_boot = atof(v);
      i++;
    } else if (!strcmp(a, "--mp3-start") && v) {
      cfg.mp3_start = atof(v);
      i++;
    } else if (!strcmp(a, "--mp3-double-finish")) cfg.double_finish = 1;
    else if (!strcmp(a, "--no-mp3")) cfg.no_mp3 = 1;
    else if (!strcmp(a, "--no-rfid")) cfg.no_rfid = 1;
    else if (!strcmp(a, "--reqa-answers")) cfg.reqa_answers = 1;
    else if (!strcmp(a, "--rfid-version") && v) {
      cfg.rfid_version = (int)strtol(v, NULL, 0);
      i++;
    } else if (!strcmp(a, "--bat-pin") && v) {
      cfg.bat_pin_mv = atoi(v);
      i++;
    } else if (!strcmp(a, "--eeprom") && v) {
      cfg.eeprom_file = v;
      i++;
    } else if (!strncmp(a, "--realtime", 10)) cfg.realtime = a[10] == '=' ? atof(a + 11) : 1;
    else if (!strcmp(a, "--quiet")) quiet = 1;
    else if (a[0] == '-') usage();
    else firmware = a;
  }
  if (!firmware) usage();

  const char *dot = strrchr(firmware, '.');
  if (dot && !strcmp(dot, ".hex")) {
    uint32_t start;
    flash_image = read_ihex_file(firmware, &flash_size, &start);
  } else {
    FILE *fp = fopen(firmware, "rb");
    if (fp) {
      flash_image = malloc(32768);
      flash_size = (uint32_t)fread(flash_image, 1, 32768, fp);
      fclose(fp);
    }
  }
  if (!flash_image || !flash_size) {
    fprintf(stderr, "cannot read %s\n", firmware);
    return 3;
  }

  avr = avr_make_mcu_by_name("atmega328p");
  avr_init(avr);
  avr->frequency = 16000000;
  avr->vcc = avr->avcc = avr->aref = 5000;
  avr->sleep = sleep_none;
  avr->log = 0;
  memcpy(avr->flash, flash_image, flash_size);
  avr->codeend = flash_size;
  avr->pc = 0;

  if (cfg.eeprom_file) {
    FILE *fp = fopen(cfg.eeprom_file, "rb");
    if (fp) {
      if (fread(eeprom_save, 1, 1024, fp) == 1024) eeprom_set(eeprom_save);
      fclose(fp);
    }
  }

  uint32_t flags = 0;
  avr_ioctl(avr, AVR_IOCTL_UART_GET_FLAGS('0'), &flags);
  flags &= ~(AVR_UART_FLAG_STDIO | AVR_UART_FLAG_POLL_SLEEP);
  avr_ioctl(avr, AVR_IOCTL_UART_SET_FLAGS('0'), &flags);
  avr_irq_register_notify(avr_io_getirq(avr, AVR_IOCTL_UART_GETIRQ('0'), UART_IRQ_OUTPUT), uart_out, NULL);
  avr_irq_register_notify(pin_irq('D', 3), mcu_tx_change, NULL);
  avr_irq_register_notify(avr_io_getirq(avr, AVR_IOCTL_SPI_GETIRQ(0), SPI_IRQ_OUTPUT), spi_byte, NULL);
  avr_irq_register_notify(pin_irq('B', 2), rc_cs, NULL);
  if (cfg.aio) {
    avr_register_io_read(avr, 0x39, lgt_spfr_read, NULL);
    bit_cyc *= 1.25;
  }

  rc_defaults();
  mp3_power(1);
  outside_levels();
  hp_apply();
  ev("sim", "power on: %s, %s, %d buttons%s", firmware, cfg.aio ? "AiO pins" : "Classic pins", cfg.buttons == 9 ? 3 : cfg.buttons,
     cfg.buttons ? "" : " (from the box's start)");

  wall0 = wall_now();
  int quit = 0;
  while (!quit) {
    int r = read_stdin(cfg.realtime <= 0);
    if (r < 0) break;
    if (r == 0) {  // real-time mode, nothing to do: the box runs on
      advance(0.01);
      continue;
    }
    char line[600];
    snprintf(line, sizeof line, "%s", pending[pend_tail]);
    pend_tail = (pend_tail + 1) % 64;
    char *hash = strchr(line, '#');
    if (hash && strncmp(line, "serial", 6) && strncmp(line, "until", 5)) *hash = 0;
    line[strcspn(line, "\r\n")] = 0;
    char *p = line;
    while (*p == ' ' || *p == '\t') p++;
    if (!*p) continue;
    int no = ++cmd_no;
    char echo[600];
    snprintf(echo, sizeof echo, "%s", p);
    ev(">", "%s", echo);
    const char *err = run_command(p);
    if (err && !strcmp(err, "quit")) {
      quit = 1;
      err = NULL;
    }
    if (err) {
      failures++;
      ev("=fail", "%d %s", no, err);
    } else ev("=ok", "%d", no);
    // Buttons from the box's start: put the keys of the other wiring at rest once known.
    if (boot_buttons_seen) {
      boot_buttons_seen = 0;
      outside_levels();
    }
  }
  if (cfg.eeprom_file) {
    eeprom_get(eeprom_save);
    FILE *fp = fopen(cfg.eeprom_file, "wb");
    if (fp) {
      fwrite(eeprom_save, 1, 1024, fp);
      fclose(fp);
    }
  }
  return failures ? 5 : 0;
}
