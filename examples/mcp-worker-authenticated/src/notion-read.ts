// Kaur workspace only. No create/update/delete endpoints are exposed.
export const KAUR_WORKSPACE_ID = "0c473eb3-b036-8155-b5dc-0003190f498c";
export const KAUR_BOT_ID = "40473eb3-b036-81c7-aa96-002712d87e6b";
// export const TASKS_SOURCE_ID = "40473eb3-0362-8243-a082-879ae0fc3738";
export const TASKS_SOURCE_ID = "40473eb3-b036-8243-a082-879ae0fc3738";
export const TASKS_DATABASE_ID = "47873eb3-b036-82c1-932c-016249a55628";
type Identity = { userId?: unknown; username?: unknown };
type Json = Record<string, any>;
export type ReadKind = "page" | "database" | "data_source" | "block_children";
const normalize = (value: string) => value.replace(/-/g, "").toLowerCase();
function id(value: string) {
  if (!/^(?:[0-9a-f]{32}|[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$/i.test(value)) {
    throw new Error("ID Notion harus UUID, bukan URL atau nama halaman.");
  }
  return value;
}
function size(value: number) {
  if (!Number.isInteger(value) || value < 1 || value > 50) throw new Error("page_size harus 1 sampai 50.");
  return value;
}

export class NotionKaurRead {
  constructor(private token: string | undefined, private identity: Identity | undefined,
    private http: typeof fetch = fetch.bind(globalThis)) {}

  private async request(method: "GET" | "POST", path: string, body?: Json): Promise<Json> {
    if (String(this.identity?.userId) !== "18157510" || this.identity?.username !== "sendyprayogo") {
      throw new Error("Akses ditolak: identitas GitHub pemilik diperlukan.");
    }
    if (!this.token || /\s/.test(this.token)) throw new Error("Secret NOTION_KAUR_TOKEN belum terpasang atau mengandung spasi/baris baru.");
    const allowed = method === "GET"
      ? /^\/(?:users\/me|(?:pages|databases|data_sources)\/[0-9a-f-]+|blocks\/[0-9a-f-]+\/children(?:\?.*)?)$/i.test(path)
      : method === "POST" && (path === "/search" || /^\/data_sources\/[0-9a-f-]+\/query$/i.test(path));
    if (!allowed) throw new Error("Endpoint di luar alat baca ditolak.");
    let response: Response;
    try {
      response = await this.http(`https://api.notion.com/v1${path}`, {
        method, redirect: "manual", signal: AbortSignal.timeout(20000),
        headers: { Authorization: `Bearer ${this.token}`, "Notion-Version": "2026-03-11", "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
    } catch { throw new Error("Koneksi API Notion gagal atau melewati 20 detik. Coba kembali."); }
    if (response.status >= 300 && response.status < 400) {
      throw new Error("API Notion mengembalikan pengalihan. Permintaan dihentikan agar token tidak diteruskan ke alamat lain.");
    }
    let data: Json;
    try { data = await response.json() as Json; }
    catch { throw new Error(`Respons Notion bukan JSON (HTTP ${response.status}).`); }
    if (!response.ok) {
      const code = typeof data.code === "string" && /^[a-z_]{1,64}$/.test(data.code) ? data.code : "unknown";
      const hint = response.status === 401 ? "Periksa token integrasi Kaur."
        : response.status === 403 || response.status === 404 ? "Periksa Edit access integrasi Kaur pada halaman/database sumber."
        : response.status === 429 ? "Batas permintaan Notion tercapai; tunggu sebelum mencoba lagi."
        : "Periksa input dan skema database; coba kembali.";
      throw new Error(`Notion HTTP ${response.status} (${code}). ${hint}`);
    }
    return data;
  }

  async check() {
    const me = await this.request("GET", "/users/me");
    // The bot ID was verified by the earlier successful local read probe.
    if (me.type !== "bot" || normalize(me.id || "") !== normalize(KAUR_BOT_ID)
      || (me.bot?.workspace_id && normalize(me.bot.workspace_id) !== normalize(KAUR_WORKSPACE_ID))) {
      throw new Error("Token bukan integrasi Asisten Kaur Faspro yang telah diverifikasi. Akses workspace ditolak.");
    }
    return { connected: true, read_only: true, integration_name: me.name,
      workspace_id: me.bot?.workspace_id || KAUR_WORKSPACE_ID,
      workspace_name: me.bot?.workspace_name || "Pembelajaran Digital dan Pusat Bahasa's Space",
      tasks_database_id: TASKS_DATABASE_ID, tasks_data_source_id: TASKS_SOURCE_ID,
      scope: "Hanya halaman/database yang dibagikan kepada integrasi ini; bukan otomatis seluruh workspace." };
  }

  async search(query: string, pageSize = 20, cursor?: string) {
    if (typeof query !== "string" || query.length > 200) throw new Error("Kata pencarian maksimal 200 karakter.");
    size(pageSize);
    await this.check();
    const data = await this.request("POST", "/search", {
      query, page_size: pageSize, ...(cursor ? { start_cursor: cursor } : {})
    });
    return { has_more: data.has_more, next_cursor: data.next_cursor,
      note: "Pencarian API Notion berdasarkan judul, bukan pencarian penuh isi halaman.",
      results: (data.results || []).map((item: Json) => {
        const titleProperty = Object.values(item.properties || {}).find((p: any) => p.type === "title") as Json | undefined;
        return { id: item.id, object: item.object, title: (item.title || titleProperty?.title || []).map((t: Json) => t.plain_text || t.text?.content || "").join(""),
          url: item.url, parent: item.parent, last_edited_time: item.last_edited_time };
      }) };
  }

  async read(kind: ReadKind, resourceId: string, pageSize = 20, cursor?: string) {
    id(resourceId); size(pageSize);
    const paths: Record<ReadKind, string> = { page: "pages", database: "databases", data_source: "data_sources", block_children: "blocks" };
    if (!(kind in paths)) throw new Error("Jenis pembacaan tidak valid.");
    await this.check();
    let path = `/${paths[kind]}/${resourceId}`;
    if (kind === "block_children") {
      const query = new URLSearchParams({ page_size: String(pageSize), ...(cursor ? { start_cursor: cursor } : {}) });
      path += `/children?${query}`;
    }
    const data = await this.request("GET", path);
    return { ...data, reading_note: kind === "page" ? "Ini metadata/properti. Baca block_children dengan ID halaman untuk isi."
      : kind === "block_children" ? "Satu tingkat blok saja. Gunakan next_cursor bila has_more, dan baca ID blok dengan has_children untuk isi turunannya."
      : "Gunakan skema/data_sources ini untuk membaca baris; bukan data seluruh database." };
  }

  async query(sourceId = TASKS_SOURCE_ID, pageSize = 20, cursor?: string, filterJson?: string) {
    id(sourceId); size(pageSize);
    let filter: unknown;
    if (filterJson) {
      if (filterJson.length > 10000) throw new Error("Filter terlalu panjang.");
      try { filter = JSON.parse(filterJson); } catch { throw new Error("filter_json bukan JSON yang valid."); }
      if (!filter || typeof filter !== "object" || Array.isArray(filter)) throw new Error("filter_json harus objek filter Notion.");
    }
    await this.check();
    return this.request("POST", `/data_sources/${sourceId}/query`, {
      page_size: pageSize, ...(cursor ? { start_cursor: cursor } : {}), ...(filter ? { filter } : {})
    });
  }
}
