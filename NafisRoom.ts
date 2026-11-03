import { Room, Client } from "colyseus";
import { Schema, MapSchema, type } from "@colyseus/schema";
import { createClient } from "@supabase/supabase-js";
import { randomBytes } from "crypto";

class Player extends Schema {
  @type("string") id = "";
  @type("string") nickname = "";
  @type("string") avatar = "{}";
  @type("string") groupId = "";
  @type("string") status = "pending"; // pending | approved
  @type("number") x = 0;
  @type("number") z = 0;
  @type("number") score = 0;
  @type("number") correct = 0;
  @type("number") qIndex = 0;
  @type("number") ms = 0;
  @type("number") gems = 0;
}
class Team extends Schema {
  @type("string") name = "";
  @type("string") color = "#6a3df0";
  @type("number") correct = 0; // في المغامرة = عدد المفاتيح/الجواهر المجمّعة
  @type("number") points = 0;
  @type("number") ms = 0;
}
class State extends Schema {
  @type("string") status = "waiting";
  @type("string") mode = "race";
  @type("number") total = 0;
  @type({ map: Player }) players = new MapSchema<Player>();
  @type({ map: Team }) teams = new MapSchema<Team>();
}

const MAX_BONUS = 30, BONUS_WINDOW_MS = 20000, FINISH_BONUS = 50;

export class NafisRoom extends Room<State> {
  maxClients = 60;
  db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!, { auth: { persistSession: false } });
  row: any; qs: any[] = []; keys: number[] = []; loaded = false; busy = false;
  sent = new Map<string, { i: number; t: number }>();
  tokens = new Map<string, string>();
  lastMove = new Map<string, number>();

  async onCreate(o: any) {
    const code = String(o.code || "").toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code)) throw new Error("رمز غرفة غير صالح");
    const { data } = await this.db.from("rooms").select("*").eq("code", code).maybeSingle();
    if (!data) throw new Error("رمز غرفة غير صحيح");
    this.row = data;
    this.setState(new State());
    this.state.mode = data.mode;
    this.state.status = data.status;

    this.onMessage("move", (c, m) => {
      const p = this.state.players.get(c.sessionId);
      if (!p || p.status !== "approved") return;
      const x = Number(m?.x), z = Number(m?.z);
      if (!isFinite(x) || !isFinite(z) || Math.abs(x) > 300 || Math.abs(z) > 300) return;
      const now = Date.now(), dt = Math.min(1, (now - (this.lastMove.get(c.sessionId) || now - 100)) / 1000);
      if (Math.hypot(x - p.x, z - p.z) > 20 * dt + 2) return; // منع القفز/الغش
      p.x = x; p.z = z; this.lastMove.set(c.sessionId, now);
    });
    this.onMessage("answer", (c, m) => this.answer(c, m));
    this.clock.setInterval(() => this.sync(), 2000);
  }

  async onAuth(client: Client, o: any) {
    const nick = String(o.nickname || "").trim();
    if (nick.length < 2 || nick.length > 20) throw new Error("الاسم من 2 إلى 20 حرفًا");
    const { data } = await this.db.from("students").select("*").eq("room_id", this.row.id).eq("nickname", nick).maybeSingle();
    if (data) {
      if (data.status === "rejected") throw new Error("لم يتم قبول طلب الانضمام");
      if (!o.token || this.tokens.get(data.id) !== o.token) throw new Error("هذا الاسم مستخدم، اختاري اسمًا آخر");
      return data;
    }
    const ins = await this.db.from("students").insert({ room_id: this.row.id, nickname: nick, avatar: this.avatar(o.avatar) }).select("*").single();
    if (ins.error) throw new Error("تعذّر إرسال طلب الانضمام");
    return ins.data;
  }

  avatar(a: any) { // قائمة بيضاء: لا بيانات شخصية
    const out: any = {};
    for (const k of ["color", "hat", "outfit", "face"]) if (typeof a?.[k] === "string" && /^[\w#-]{1,20}$/.test(a[k])) out[k] = a[k];
    return out;
  }

  async onJoin(client: Client, _o: any, row: any) {
    client.userData = row.id;
    if (!this.tokens.has(row.id)) this.tokens.set(row.id, randomBytes(16).toString("hex"));
    const p = new Player();
    Object.assign(p, { id: row.id, nickname: row.nickname, avatar: JSON.stringify(row.avatar || {}), groupId: row.group_id || "", status: row.status === "approved" ? "approved" : "pending", gems: row.gems });
    const { data } = await this.db.from("answers").select("is_correct,points,time_ms").eq("student_id", row.id);
    for (const a of data || []) { p.qIndex++; p.score += a.points; p.ms += a.time_ms; if (a.is_correct) p.correct++; }
    this.state.players.set(client.sessionId, p);
    client.send("joined", { token: this.tokens.get(row.id), studentId: row.id });
  }
  onLeave(client: Client) { this.state.players.delete(client.sessionId); this.sent.delete(client.sessionId); this.lastMove.delete(client.sessionId); }

  async loadQuestions() {
    if (!this.row.week_id) { this.loaded = true; return; }
    const wk = await this.db.from("weeks").select("publish_at").eq("id", this.row.week_id).single();
    if (wk.data?.publish_at && new Date(wk.data.publish_at) > new Date()) return; // لم يحن موعد النشر
    const wq = await this.db.from("week_questions").select("question_id").eq("week_id", this.row.week_id).eq("kind", "competition").order("position");
    const ids = (wq.data || []).map((r: any) => r.question_id);
    if (!ids.length) { this.loaded = true; return; }
    const [q, k] = await Promise.all([
      this.db.from("questions").select("id,body,image_path,choices,explanation").in("id", ids).eq("status", "published"),
      this.db.from("question_keys").select("question_id,correct_index").in("question_id", ids)]);
    const qm = new Map((q.data || []).map((x: any) => [x.id, x])), km = new Map((k.data || []).map((x: any) => [x.question_id, x.correct_index]));
    this.qs = ids.filter((i: string) => qm.has(i) && km.has(i)).map((i: string) => qm.get(i));
    this.keys = this.qs.map((x: any) => km.get(x.id));
    this.state.total = this.qs.length; this.loaded = true;
  }

  async sync() {
    if (this.busy || this.state.status === "finished") return;
    this.busy = true;
    try {
      const [r, s, g] = await Promise.all([
        this.db.from("rooms").select("status,started_at").eq("id", this.row.id).single(),
        this.db.from("students").select("id,status,group_id").eq("room_id", this.row.id),
        this.db.from("room_groups").select("*").eq("room_id", this.row.id)]);
      if (r.data) { this.state.status = r.data.status; this.row.started_at = r.data.started_at; }
      if (this.state.status === "running" && !this.loaded) await this.loadQuestions();
      for (const x of g.data || []) { const t = this.state.teams.get(x.id) || new Team(); t.name = x.name; t.color = x.color || "#6a3df0"; this.state.teams.set(x.id, t); }
      const byId = new Map((s.data || []).map((x: any) => [x.id, x]));
      this.state.players.forEach((p) => { const d: any = byId.get(p.id); if (d) { p.status = d.status === "approved" ? "approved" : "pending"; p.groupId = d.group_id || ""; } });
      // انتهاء الوقت
      if (this.state.status === "running" && this.row.started_at && Date.now() > new Date(this.row.started_at).getTime() + this.row.duration_sec * 1000) return this.finish();
      this.recompute();
      // إرسال السؤال التالي لكل طالبة مقبولة
      if (this.state.status === "running") for (const c of this.clients) {
        const p = this.state.players.get(c.sessionId);
        if (p && p.status === "approved" && p.qIndex < this.qs.length && !this.sent.has(c.sessionId)) this.sendQuestion(c, p);
      }
      // اكتمال جميع المقبولات في مجموعات
      const play = [...this.state.players.values()].filter((p) => p.status === "approved" && p.groupId);
      if (this.state.status === "running" && this.qs.length && play.length && play.every((p) => p.qIndex >= this.qs.length)) await this.finish();
    } catch (e) { console.error(e); } finally { this.busy = false; }
  }

  async sendQuestion(c: Client, p: Player) {
    const q = this.qs[p.qIndex], rec = { i: p.qIndex, t: Date.now() };
    this.sent.set(c.sessionId, rec); // يمنع الإرسال المكرر أثناء الانتظار
    let image_url: string | null = null;
    if (q.image_path) { const r = await this.db.storage.from("question-images").createSignedUrl(q.image_path, 3600); image_url = r.data?.signedUrl || null; }
    rec.t = Date.now();
    c.send("question", { id: q.id, index: p.qIndex, total: this.qs.length, body: q.body, image_url, choices: q.choices }); // بلا الإجابة الصحيحة
  }

  async answer(c: Client, m: any) {
    const p = this.state.players.get(c.sessionId), s = this.sent.get(c.sessionId);
    if (!p || !s || p.status !== "approved" || this.state.status !== "running") return;
    const q = this.qs[s.i], choice = Number(m?.choice);
    if (!q || m?.questionId !== q.id || !(choice >= 0 && choice <= 3)) return;
    this.sent.delete(c.sessionId);
    p.qIndex = s.i + 1;
    const ms = Date.now() - s.t, ok = choice === this.keys[s.i], last = s.i === this.qs.length - 1;
    // 100 للصحيحة + مكافأة سرعة محدودة + مكافأة إكمال المرحلة؛ لا نقاط للخاطئة
    const pts = ok ? 100 + Math.max(0, Math.round(MAX_BONUS * (1 - ms / BONUS_WINDOW_MS))) + (last ? FINISH_BONUS : 0) : 0;
    const ins = await this.db.from("answers").insert({ room_id: this.row.id, student_id: p.id, question_id: q.id, chosen_index: choice, is_correct: ok, points: pts, time_ms: ms });
    if (ins.error) { if (ins.error.code !== "23505") p.qIndex = s.i; return; } // 23505 = سبق الرد على السؤال
    p.ms += ms;
    if (ok) { p.correct++; p.score += pts; p.gems++; await this.db.from("students").update({ gems: p.gems }).eq("id", p.id); }
    this.recompute();
    c.send("result", { questionId: q.id, correct: ok, points: pts });
    if (p.qIndex >= this.qs.length) this.review(c);
    else this.sendQuestion(c, p);
  }

  recompute() {
    this.state.teams.forEach((t) => { t.correct = 0; t.points = 0; t.ms = 0; });
    this.state.players.forEach((p) => { const t = this.state.teams.get(p.groupId); if (t && p.status === "approved") { t.correct += p.correct; t.points += p.score; t.ms += p.ms; } });
  }
  review(c: Client) { c.send("review", this.qs.map((q, i) => ({ id: q.id, correct: this.keys[i], explanation: q.explanation }))); }
  async finish() {
    this.state.status = "finished";
    await this.db.from("rooms").update({ status: "finished" }).eq("id", this.row.id);
    this.recompute();
    this.clients.forEach((c) => this.review(c)); // الإجابات تظهر بعد انتهاء المنافسة فقط
  }
}
