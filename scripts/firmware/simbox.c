// Sanity check for builds of the Firmware-Baukasten (docs/FIRMWARE-BAUKASTEN.md):
// runs a TonUINO Classic build in simavr (ATmega328P, 16 MHz), prints the
// serial log with the simulated time, turns a rotary encoder on A3 (CLK) /
// A4 (DT) or a poti on A3, or holds A6 high from the start (alarm start,
// SPECIAL_START_SHORTCUT, "alarm"; "none" leaves it at 0 V), or types lines into
// the serial port ("serial", e.g. WRITECARD of the write-card preview,
// src/core/firmware/writecard.ts), and at the end the state of ports B, C, D (output
// level, direction, number of level changes per pin). Not part of the app.
//
//   sudo apt-get install simavr libsimavr-dev
//   gcc -O2 -o /tmp/simbox scripts/firmware/simbox.c -I/usr/include/simavr -lsimavr
//   avr-objcopy -I binary -O ihex classic-3-encoder.bin /tmp/classic-3-encoder.hex
//   /tmp/simbox /tmp/classic-3-encoder.hex encoder|poti|alarm|none
//   /tmp/simbox /tmp/classic-3-writeCard.hex serial "WRITECARD CANCEL" "WRITECARD 1,5" ...
//
// Without DFPlayer and RFID reader the box waits about 40 simulated seconds
// before "enter Idle"; that takes some 10 s.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <simavr/sim_avr.h>
#include <simavr/sim_hex.h>
#include <simavr/avr_ioport.h>
#include <simavr/avr_uart.h>
#include <simavr/avr_adc.h>

static avr_t *avr;
static char line[256];
static int len;
static int idle_seen;
static double idle_at;

static int toggles[3][8];
static void pin_change(struct avr_irq_t *irq, uint32_t value, void *param) {
  (void)value; int port = (int)(intptr_t)param; toggles[port][irq->irq] ++;
}
static void report_pins(const char *when) {
  const char ports[3] = {'B', 'C', 'D'};
  for (int i = 0; i < 3; i++) {
    avr_ioport_state_t st;
    avr_ioctl(avr, AVR_IOCTL_IOPORT_GETSTATE(ports[i]), &st);
    printf("%s PORT%c out=%02x ddr=%02x toggles:", when, ports[i], st.port, st.ddr);
    for (int b = 0; b < 8; b++) printf(" %d", toggles[i][b]);
    printf("\n");
  }
}

static double now(void) { return (double)avr->cycle / avr->frequency; }

static void uart_out(struct avr_irq_t *irq, uint32_t value, void *param) {
  (void)irq; (void)param;
  char c = (char)value;
  if (c == '\r') return;
  if (c == '\n' || len == (int)sizeof(line) - 1) {
    line[len] = 0;
    printf("[%8.3f] %s\n", now(), line);
    if (!idle_seen && strstr(line, "enter Idle")) { idle_seen = 1; idle_at = now(); }
    len = 0;
    return;
  }
  line[len++] = c;
}

static void run_until(double t) {
  while (now() < t) {
    int state = avr_run(avr);
    if (state == cpu_Done || state == cpu_Crashed) { printf("cpu stopped (%d)\n", state); exit(1); }
  }
}

// One line into the box's serial port, a byte per 100 us (115200 baud), then "\n".
static void type_line(const char *text) {
  avr_irq_t *rx = avr_io_getirq(avr, AVR_IOCTL_UART_GETIRQ('0'), UART_IRQ_INPUT);
  printf("[%8.3f] -- send \"%s\"\n", now(), text);
  for (const char *c = text;; c++) {
    avr_raise_irq(rx, *c ? (uint8_t)*c : '\n');
    run_until(now() + 0.0001);
    if (!*c) break;
  }
}

int main(int argc, char **argv) {
  if (argc < 3) return 2;
  uint32_t size, start;
  uint8_t *code = read_ihex_file(argv[1], &size, &start);
  if (!code) return 3;
  avr = avr_make_mcu_by_name("atmega328p");
  avr_init(avr);
  avr->frequency = 16000000;
  memcpy(avr->flash, code, size);
  avr->codeend = size;
  avr->pc = 0;

  uint32_t flags = 0;
  avr_ioctl(avr, AVR_IOCTL_UART_GET_FLAGS('0'), &flags);
  flags &= ~AVR_UART_FLAG_STDIO;
  avr_ioctl(avr, AVR_IOCTL_UART_SET_FLAGS('0'), &flags);
  avr_irq_register_notify(avr_io_getirq(avr, AVR_IOCTL_UART_GETIRQ('0'), UART_IRQ_OUTPUT), uart_out, NULL);

  avr_irq_t *clk = avr_io_getirq(avr, AVR_IOCTL_IOPORT_GETIRQ('C'), 3); // A3
  avr_irq_t *dt = avr_io_getirq(avr, AVR_IOCTL_IOPORT_GETIRQ('C'), 4);  // A4
  avr_irq_t *adc3 = avr_io_getirq(avr, AVR_IOCTL_ADC_GETIRQ, ADC_IRQ_ADC3);
  // Buttons A0..A2 not pressed (pull-ups), encoder at rest high (module pull-ups).
  for (int p = 0; p < 3; p++) avr_raise_irq(avr_io_getirq(avr, AVR_IOCTL_IOPORT_GETIRQ('C'), p), 1);
  avr_raise_irq(clk, 1);
  avr_raise_irq(dt, 1);
  avr_raise_irq(adc3, 2500);
  avr_raise_irq(avr_io_getirq(avr, AVR_IOCTL_ADC_GETIRQ, ADC_IRQ_ADC6), strcmp(argv[2], "alarm") ? 0 : 5000);
  const char ports[3] = {'B', 'C', 'D'};
  for (int i = 0; i < 3; i++)
    for (int b = 0; b < 8; b++)
      avr_irq_register_notify(avr_io_getirq(avr, AVR_IOCTL_IOPORT_GETIRQ(ports[i]), b), pin_change, (void *)(intptr_t)i);

  while (!idle_seen && now() < 60) run_until(now() + 0.01);
  if (!idle_seen) { printf("no idle\n"); return 4; }
  double t = idle_at + 0.5;
  run_until(t);
  if (!strcmp(argv[2], "encoder")) {
    int dirs[] = {1, 1, 1, 0, 0};
    for (int i = 0; i < 5; i++) {
      printf("[%8.3f] -- turn %s\n", now(), dirs[i] ? "right (DT high)" : "left (DT low)");
      avr_raise_irq(dt, dirs[i]);
      run_until(now() + 0.005);
      avr_raise_irq(clk, 0);
      run_until(now() + 0.020);
      avr_raise_irq(clk, 1);
      avr_raise_irq(dt, 1);
      run_until(now() + 0.300);
    }
  } else if (!strcmp(argv[2], "serial")) {
    for (int i = 3; i < argc; i++) {
      type_line(argv[i]);
      run_until(now() + 3.0);
    }
  } else if (!strcmp(argv[2], "poti")) {
    int mv[] = {0, 5000, 2500};
    for (int i = 0; i < 3; i++) {
      printf("[%8.3f] -- poti %d mV\n", now(), mv[i]);
      avr_raise_irq(adc3, mv[i]);
      run_until(now() + 0.5);
    }
  }
  run_until(now() + 0.5);
  report_pins("end");
  return 0;
}
