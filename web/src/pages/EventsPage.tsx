import React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Badge, Button, Input, PanelHeader, Spinner } from "@open-hax/uxx";
import {
  addEventTag,
  getEventById,
  listEvents,
  listEventTags,
  removeEventTag,
  type ProxyEvent,
} from "../lib/api";

function formatMaybe(value: string | undefined): string {
  return value && value.trim().length > 0 ? value : "-";
}

function formatMaybeNumber(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "-";
}

function formatBytes(bytes: number | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return "-";
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${bytes} B`;
}

function formatTs(ts: string): string {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return ts;
  }
}

function compactJson(value: unknown, limit = 400): string {
  const text = JSON.stringify(value, null, 2);
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…`;
}

export function EventsPage(): JSX.Element {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [kind, setKind] = useState<string>("");
  const [providerId, setProviderId] = useState<string>("");
  const [model, setModel] = useState<string>("");
  const [tag, setTag] = useState<string>("");
  const [since, setSince] = useState<string>("");

  const [offset, setOffset] = useState(0);
  const [limit, setLimit] = useState(50);

  const [events, setEvents] = useState<readonly ProxyEvent[]>([]);
  const [totalCount, setTotalCount] = useState<number | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<ProxyEvent | null>(null);
  const [selectedLoading, setSelectedLoading] = useState(false);
  const [tagInput, setTagInput] = useState("");

  const [tagSummary, setTagSummary] = useState<Record<string, number> | null>(null);
  const [tagSummarySince, setTagSummarySince] = useState<string | null>(null);

  const filters = useMemo(() => {
    return {
      kind: kind.trim().length > 0 ? kind.trim() : undefined,
      providerId: providerId.trim().length > 0 ? providerId.trim() : undefined,
      model: model.trim().length > 0 ? model.trim() : undefined,
      tag: tag.trim().length > 0 ? tag.trim() : undefined,
      since: since.trim().length > 0 ? new Date(since).toISOString() : undefined,
      limit,
      offset,
      includePayload: false,
      includeCount: true,
    } as const;
  }, [kind, providerId, model, tag, since, limit, offset]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const payload = await listEvents(filters);
      setEvents(payload.events);
      setTotalCount(typeof payload.totalCount === "number" ? payload.totalCount : null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    void listEventTags()
      .then((payload) => {
        setTagSummary(payload.tags);
        setTagSummarySince(payload.since);
      })
      .catch(() => {
        setTagSummary(null);
        setTagSummarySince(null);
      });
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setSelectedEvent(null);
      return;
    }

    setSelectedLoading(true);
    void getEventById(selectedId)
      .then((ev) => setSelectedEvent(ev))
      .catch((err) => {
        setSelectedEvent(null);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setSelectedLoading(false));
  }, [selectedId]);

  const canPrev = offset > 0;
  const canNext = events.length === limit && (totalCount === null || offset + limit < totalCount);

  const handleApplyFilters = () => {
    setOffset(0);
    void refresh();
  };

  const handleAddTag = async () => {
    const trimmed = tagInput.trim();
    if (!selectedEvent || trimmed.length === 0) return;
    await addEventTag(selectedEvent.id, trimmed);
    setTagInput("");
    setSelectedEvent(await getEventById(selectedEvent.id));
  };

  const handleRemoveTag = async (tagValue: string) => {
    if (!selectedEvent) return;
    await removeEventTag(selectedEvent.id, tagValue);
    setSelectedEvent(await getEventById(selectedEvent.id));
  };

  return (
    <div className="events-page">
      <PanelHeader
        title="Events"
        subtitle="Raw proxy events (request/response/error) from the SQL event store."
      />

      <div className="events-controls">
        <div className="events-filters">
          <label>
            Kind
            <Input value={kind} onChange={(e) => setKind(e.currentTarget.value)} placeholder="request | response | error" />
          </label>
          <label>
            Provider
            <Input value={providerId} onChange={(e) => setProviderId(e.currentTarget.value)} placeholder="openai / ollama-cloud / …" />
          </label>
          <label>
            Model
            <Input value={model} onChange={(e) => setModel(e.currentTarget.value)} placeholder="gpt-4.1 / gemma4:31b / …" />
          </label>
          <label>
            Tag
            <Input value={tag} onChange={(e) => setTag(e.currentTarget.value)} placeholder="label:train" />
          </label>
          <label>
            Since
            <Input value={since} onChange={(e) => setSince(e.currentTarget.value)} placeholder="2026-04-28" />
          </label>

          <div className="events-filter-actions">
            <Button variant="primary" onClick={handleApplyFilters} disabled={loading}>
              Apply
            </Button>
            <Button
              variant="default"
              onClick={() => {
                setKind("");
                setProviderId("");
                setModel("");
                setTag("");
                setSince("");
                setOffset(0);
              }}
              disabled={loading}
            >
              Clear
            </Button>
          </div>
        </div>

        <div className="events-pagination">
          <div className="events-pagination-row">
            <Button
              variant="default"
              onClick={() => setOffset((v) => Math.max(0, v - limit))}
              disabled={!canPrev || loading}
            >
              Prev
            </Button>
            <Button
              variant="default"
              onClick={() => setOffset((v) => v + limit)}
              disabled={!canNext || loading}
            >
              Next
            </Button>
            <span className="events-pagination-meta">
              offset {offset} · limit {limit}{totalCount !== null ? ` · total ${totalCount}` : ""}
            </span>
          </div>

          <label className="events-limit">
            Limit
            <Input
              value={String(limit)}
              onChange={(e) => {
                const next = Number.parseInt(e.currentTarget.value, 10);
                setLimit(Number.isFinite(next) && next > 0 ? Math.min(next, 500) : 50);
              }}
            />
          </label>
        </div>
      </div>

      {tagSummary && (
        <div className="events-tag-summary">
          <div className="events-tag-summary-header">
            <strong>Tag counts</strong>
            <small>{tagSummarySince ? `since ${formatTs(tagSummarySince)}` : ""}</small>
          </div>
          <div className="events-tag-summary-badges">
            {Object.entries(tagSummary).slice(0, 16).map(([t, n]) => (
              <button
                key={t}
                type="button"
                className="events-tag-summary-pill"
                onClick={() => {
                  setTag(t);
                  setOffset(0);
                }}
              >
                <span>{t}</span>
                <Badge variant="default">{n}</Badge>
              </button>
            ))}
          </div>
        </div>
      )}

      {error && <div className="events-error">{error}</div>}

      <div className="events-grid">
        <section className="events-list">
          {loading ? (
            <div className="events-loading"><Spinner /> Loading events…</div>
          ) : (
            <table className="events-table">
              <thead>
                <tr>
                  <th>ts</th>
                  <th>kind</th>
                  <th>provider/account</th>
                  <th>model</th>
                  <th>status</th>
                  <th>tags</th>
                  <th>payload</th>
                </tr>
              </thead>
              <tbody>
                {events.map((ev) => {
                  const isSelected = selectedId === ev.id;
                  return (
                    <tr
                      key={ev.id}
                      className={isSelected ? "events-row events-row-selected" : "events-row"}
                      onClick={() => setSelectedId(ev.id)}
                    >
                      <td className="events-mono">{formatTs(ev.ts)}</td>
                      <td><Badge variant={ev.kind === "error" ? "error" : ev.kind === "response" ? "success" : "default"}>{ev.kind}</Badge></td>
                      <td className="events-mono">{formatMaybe(ev.providerId)}/{formatMaybe(ev.accountId)}</td>
                      <td className="events-mono">{formatMaybe(ev.model)}</td>
                      <td className="events-mono">{formatMaybeNumber(ev.status)}</td>
                      <td className="events-tags">
                        {ev.tags.slice(0, 3).map((t) => (
                          <Badge key={t} variant="default">{t}</Badge>
                        ))}
                        {ev.tags.length > 3 ? <span className="events-tags-more">+{ev.tags.length - 3}</span> : null}
                      </td>
                      <td className="events-mono">{formatBytes(ev.payloadBytes)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>

        <aside className="events-detail">
          {!selectedId ? (
            <div className="events-empty">Select an event to inspect its payload.</div>
          ) : selectedLoading ? (
            <div className="events-loading"><Spinner /> Loading event…</div>
          ) : selectedEvent ? (
            <div className="events-detail-card">
              <div className="events-detail-header">
                <strong className="events-mono">{selectedEvent.id}</strong>
                <small>{formatTs(selectedEvent.ts)} · {selectedEvent.kind}</small>
              </div>

              <div className="events-detail-meta">
                <div><strong>entry</strong> <span className="events-mono">{selectedEvent.entryId}</span></div>
                <div><strong>provider</strong> <span className="events-mono">{formatMaybe(selectedEvent.providerId)}</span></div>
                <div><strong>account</strong> <span className="events-mono">{formatMaybe(selectedEvent.accountId)}</span></div>
                <div><strong>model</strong> <span className="events-mono">{formatMaybe(selectedEvent.model)}</span></div>
                <div><strong>status</strong> <span className="events-mono">{formatMaybeNumber(selectedEvent.status)}</span></div>
                <div><strong>payload</strong> <span className="events-mono">{formatBytes(selectedEvent.payloadBytes)}</span></div>
              </div>

              <div className="events-detail-tags">
                <div className="events-detail-tags-row">
                  {selectedEvent.tags.map((t) => (
                    <button key={t} type="button" className="events-tag-pill" onClick={() => void handleRemoveTag(t)}>
                      <span>{t}</span>
                      <span className="events-tag-pill-x">×</span>
                    </button>
                  ))}
                  {selectedEvent.tags.length === 0 ? <span className="events-muted">No tags</span> : null}
                </div>

                <div className="events-detail-tag-add">
                  <Input value={tagInput} onChange={(e) => setTagInput(e.currentTarget.value)} placeholder="add tag" />
                  <Button variant="default" onClick={() => { void handleAddTag(); }} disabled={tagInput.trim().length === 0}>
                    Add
                  </Button>
                </div>
              </div>

              <details open>
                <summary>payload</summary>
                <pre className="events-json">{compactJson(selectedEvent.payload)}</pre>
              </details>

              <details>
                <summary>meta</summary>
                <pre className="events-json">{compactJson(selectedEvent.meta)}</pre>
              </details>
            </div>
          ) : (
            <div className="events-empty">Failed to load event.</div>
          )}
        </aside>
      </div>
    </div>
  );
}
