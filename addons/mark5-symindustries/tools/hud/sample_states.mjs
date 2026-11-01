// Representative HUD states (field values per tools/hud_protocol.json) used by the decoder test
// and by preview.py. Texts are realistic PT-BR with § colour codes, accents and \n, kept within
// each field's byte width (checked by the test, so the samples never rely on truncation).
// integrity_pct is right-aligned with SPACES ("100", " 72", "  5"), as the script sends it.

const leds = (on) => ({ led_head: on, led_chest: on, led_arms: on, led_legs: on });

const COMPASS_N = "§7NO§8---+--+---§cN§8---+---+--§7NE"; // codec.js compassTape(0)
const COMPASS_SE = "§8-§7L§8---+--+---§fSE§8--+---+--§7S§8-"; // compassTape(135)

const SYSTEMS_OK =
  "§a● §fREPULSORES §aOK\n§a● §fPROPULSORES §aOK\n§a● §fESCUDO §b40%\n§7● §7MIRA §8DESARMADA\n§b● §fHUD §7-1.0/s\n§b● §fLEDs §7-1.0/s";

export const STATES = {
  idle: {
    title: "normal idle",
    fields: {
      mode: "1", energy_pct: "087", energy_frame: "17", energy_state: "n", integrity_frame: "10",
      integrity_pct: "100", integrity_state: "n",
      reticle: "i", lock_frame: "0", target_class: "0", target_hp_frame: "00", flight: "0",
      thrust_frame: "00", scan: "0", alert: "0", ...leds("1"), lock_mode: "0", threat: "0",
      compass: COMPASS_N,
      coords_text: "§7128 72 -340 §b000° N",
      energy_text: "§b87% §a+2.0/s",
      suit_text: "§7BLINDAGEM §b20\n§7VISOR §aFECHADO\n§7ESCUDO §bATIVO",
      systems_text: SYSTEMS_OK,
    },
  },
  combat: {
    title: "hostile target + locking",
    fields: {
      mode: "1", energy_pct: "064", energy_frame: "13", energy_state: "n", integrity_frame: "07",
      integrity_pct: " 72", integrity_state: "n",
      reticle: "l", lock_frame: "3", target_class: "h", target_hp_frame: "07", flight: "0",
      thrust_frame: "00", scan: "0", alert: "i", ...leds("1"), lock_mode: "1", threat: "1",
      compass: COMPASS_SE,
      coords_text: "§7131 70 -352 §b135° SE",
      energy_text: "§b64% §e+1.4/s",
      suit_text: "§7BLINDAGEM §b20\n§7VISOR §aFECHADO\n§cAMEAÇA PRÓXIMA",
      systems_text: "§a● §fREPULSORES §aOK\n§a● §fPROPULSORES §aOK\n§a● §fESCUDO §b40%\n§6● §fMIRA §6ARMADA\n§b● §fHUD §7-1.0/s\n§b● §fLEDs §7-1.0/s",
      target_text: "§f§lZumbi\n§cHOSTIL §7• AMEAÇA §cMÉDIA\n§7DIST §f12.4m\n§7VIDA §f14/20",
      alert_text: "§bADQUIRINDO ALVO: Zumbi",
    },
  },
  flight: {
    title: "flight boost + scan results + low energy alert",
    fields: {
      mode: "1", energy_pct: "021", energy_frame: "04", energy_state: "w", integrity_frame: "05",
      integrity_pct: " 54", integrity_state: "w",
      reticle: "p", lock_frame: "0", target_class: "p", target_hp_frame: "10", flight: "b",
      thrust_frame: "09", scan: "1", alert: "w", ...leds("1"), lock_mode: "0", threat: "1",
      compass: COMPASS_N,
      coords_text: "§7402 188 -911 §b000° N",
      energy_text: "§e21% §c-12.0/s",
      suit_text: "§7BLINDAGEM §b20\n§7VISOR §aFECHADO\n§eENERGIA BAIXA",
      systems_text: "§a● §fREPULSORES §aOK\n§6● §fPROPULSORES §6TURBO\n§a● §fESCUDO §b40%\n§7● §7MIRA §8DESARMADA\n§b● §fHUD §7-1.0/s\n§6● §fVOO §6-16.0/s",
      target_text: "§f§lVaca\n§aPACÍFICO §7• AMEAÇA §aBAIXA\n§7DIST §f31.0m\n§7VIDA §f10/10",
      flight_text: "§6§lTURBO §r§f38 m/s\n§7ALT §f188 §7SOLO §f+63m\n§7CALOR §e64%",
      scan_text: "§bSCAN 32m §7• §c2 hostis §7• §f1 neutro §7• §a3 pacíficos\n§c■ §fCreeper §79m NE §c20\n§c■ §fEsqueleto §714m L §c18\n§f■ §fEnderman §721m S §f40\n§a■ §fVaca §79m N §a10\n§a■ §fOvelha §717m NO §a8\n§a■ §fGalinha §725m O §a4",
      alert_text: "§eENERGIA BAIXA — 25%",
    },
  },
  critical: {
    title: "armor critical",
    fields: {
      mode: "1", energy_pct: "048", energy_frame: "10", energy_state: "n", integrity_frame: "01",
      integrity_pct: " 12", integrity_state: "c",
      reticle: "h", lock_frame: "0", target_class: "h", target_hp_frame: "09", flight: "0",
      thrust_frame: "00", scan: "0", alert: "c", ...leds("1"), lock_mode: "0", threat: "1",
      compass: COMPASS_SE,
      coords_text: "§7-57 64 1203 §b135° SE",
      energy_text: "§b48% §e+0.8/s",
      suit_text: "§7BLINDAGEM §b20\n§7VISOR §aFECHADO\n§cDANOS SEVEROS",
      systems_text: "§a● §fREPULSORES §aOK\n§a● §fPROPULSORES §aOK\n§c● §fESCUDO §cFALHA\n§7● §7MIRA §8DESARMADA\n§b● §fHUD §7-1.0/s\n§b● §fLEDs §7-1.0/s",
      target_text: "§f§lEsqueleto\n§cHOSTIL §7• AMEAÇA §cALTA\n§7DIST §f7.9m\n§7VIDA §f20/20",
      alert_text: "§c§lDANO NA ARMADURA -6%",
    },
  },
  boot: {
    title: "boot sequence",
    fields: {
      mode: "2", energy_pct: "087", energy_frame: "17", energy_state: "n", integrity_frame: "09",
      integrity_pct: " 93", integrity_state: "n",
      reticle: "i", ...leds("1"),
      boot_text: "§b> SYM OS 2.0 — INICIALIZANDO\n§7> REATOR ARC ........ §aOK\n§7> ARMADURA ........... §aOK\n§7> PROPULSORES ....... §aOK\n§7> SENSORES ........... §e...",
    },
  },
  failure: {
    title: "power failure",
    fields: {
      mode: "3", energy_pct: "000", energy_frame: "00", energy_state: "c", integrity_frame: "09",
      integrity_pct: " 87", integrity_state: "n",
      reticle: "i", ...leds("0"),
      boot_text: "§c§lSISTEMAS OFFLINE\n§cENERGIA ESGOTADA\n§7LEDs desligados\n§7Reiniciando com 15% de carga...",
    },
  },
};

// extra states for the test (not rendered as previews)
export const EXTRA_STATES = {
  critical_scanning: {
    fields: {
      mode: "1", energy_pct: "006", energy_frame: "01", energy_state: "c", integrity_frame: "01",
      integrity_pct: "  5", integrity_state: "c",
      reticle: "k", lock_frame: "5", target_class: "j", target_hp_frame: "03", flight: "e",
      thrust_frame: "02", scan: "2", alert: "c", ...leds("1"), lock_mode: "1", threat: "0",
      compass: "§8+--§7NO§8--+---+---§cN§8--+---+--", coords_text: "§70 320 0 §b180° S", energy_text: "§c6% §c-0.0/s",
      target_text: "§b§lSteve\n§bJOGADOR\n§7DIST §f4.0m\n§7VIDA §f6/20",
      flight_text: "§c§lEMERGÊNCIA\n§7ALT §f320\n§cPOUSO DE EMERGÊNCIA",
      scan_text: "§bVARRENDO... §7raio 32m",
      alert_text: "§cPOUSO DE EMERGÊNCIA",
    },
  },
  neutral_hover: {
    fields: {
      mode: "1", energy_pct: "100", energy_frame: "20", energy_state: "n", integrity_frame: "10",
      integrity_pct: "100", integrity_state: "n",
      reticle: "n", lock_frame: "0", target_class: "n", target_hp_frame: "10", flight: "h",
      thrust_frame: "04", scan: "0", alert: "0", led_head: "1", led_chest: "1", led_arms: "1", led_legs: "1",
      lock_mode: "0", threat: "0", target_text: "§f§lLobo\n§fNEUTRO §7• AMEAÇA §eMÉDIA",
      flight_text: "§bPAIRANDO §f0 m/s",
    },
  },
  integrity_zero: {
    fields: { integrity_pct: "  0", integrity_state: "c", integrity_frame: "00", alert: "c", alert_text: "§c§lARMADURA CRÍTICA — 0%" },
  },
  integrity_eighty: {
    fields: { integrity_pct: " 80", integrity_state: "n", integrity_frame: "08" },
  },
  mode0_valid: {
    fields: { mode: "0" },
  },
};
