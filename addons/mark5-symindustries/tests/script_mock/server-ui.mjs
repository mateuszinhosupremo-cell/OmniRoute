// Minimal fake of @minecraft/server-ui 2.0.0 (smoke tests). show() answers from `responses`.
export const FormCancelationReason = Object.freeze({ UserBusy: "UserBusy", UserClosed: "UserClosed" });
export const shown = [];
export const responses = [];
export class ActionFormData {
  constructor() {
    this.data = { title: "", body: "", buttons: [] };
  }
  title(t) {
    this.data.title = t;
    return this;
  }
  body(t) {
    this.data.body = t;
    return this;
  }
  button(text, icon) {
    this.data.buttons.push({ text, icon });
    return this;
  }
  show(player) {
    shown.push({ player: player.name, ...this.data });
    const r = responses.shift() ?? { canceled: true, cancelationReason: FormCancelationReason.UserClosed };
    return Promise.resolve(r);
  }
}
