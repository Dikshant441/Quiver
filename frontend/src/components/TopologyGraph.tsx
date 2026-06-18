import * as d3 from "d3";
import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  GraphLink,
  GraphNode,
  Peer,
  PulseEventDetail,
} from "../types";

const COLORS = {
  bgPrimary: "#0b1220",
  brokerFill: "#6366f1",
  brokerStroke: "rgba(165,180,252,0.7)",
  peerFill: "#1e293b",
  peerStroke: "#475569",
  peerStrokeHover: "#a5b4fc",
  peerStrokeDying: "#ef4444",
  textPrim: "#f1f5f9",
  textSec: "#94a3b8",
};

const PULSE_DURATION = 850;

interface TopologyGraphProps {
  peers: Map<string, Peer>;
  brokerId: string;
  selectedPeerId: string | null;
  onPeerClick: (peerId: string | null) => void;
  colorFor: (topic: string) => string;
}

export interface TopologyGraphHandle {
  resetView: () => void;
}

export const TopologyGraph = forwardRef<TopologyGraphHandle, TopologyGraphProps>(
  function TopologyGraph(props, ref) {
    const { peers, brokerId, selectedPeerId, onPeerClick, colorFor } = props;

    const containerRef = useRef<HTMLDivElement>(null);
    const svgRef = useRef<SVGSVGElement>(null);
    const zoomGroupRef = useRef<SVGGElement>(null);
    const linksGroupRef = useRef<SVGGElement>(null);
    const nodesGroupRef = useRef<SVGGElement>(null);
    const pulsesGroupRef = useRef<SVGGElement>(null);
    const simRef = useRef<d3.Simulation<GraphNode, GraphLink> | null>(null);
    const nodesByIdRef = useRef<Map<string, GraphNode>>(new Map());
    const linksByIdRef = useRef<Map<string, GraphLink>>(new Map());
    const zoomBehaviorRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(
      null,
    );

    // refs that downstream callbacks should always read fresh values from
    const callbacksRef = useRef({ selectedPeerId, onPeerClick });
    callbacksRef.current = { selectedPeerId, onPeerClick };
    const colorForRef = useRef(colorFor);
    colorForRef.current = colorFor;

    const [dims, setDims] = useState({ width: 800, height: 600 });
    const dimsRef = useRef(dims);
    dimsRef.current = dims;

    const [hoveredPeer, setHoveredPeer] = useState<string | null>(null);
    const [hoveredEdge, setHoveredEdge] = useState<string | null>(null);

    // ── Resize observer ──────────────────────────────────────────────────────
    useEffect(() => {
      const el = containerRef.current;
      if (!el) return;
      const ro = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const r = entry.contentRect;
          const w = Math.max(400, Math.round(r.width));
          const h = Math.max(300, Math.round(r.height));
          setDims({ width: w, height: h });
        }
      });
      ro.observe(el);
      return () => ro.disconnect();
    }, []);

    // ── One-time setup: simulation + zoom + click handlers ───────────────────
    useEffect(() => {
      if (!svgRef.current) return;
      const svg = d3.select(svgRef.current);

      const zoomBehavior = d3
        .zoom<SVGSVGElement, unknown>()
        .scaleExtent([0.2, 4])
        .filter((event: any) => {
          // Don't pan when starting a drag on a peer node or interactive child
          if (event.type === "mousedown") {
            const target = event.target as Element;
            if (target && target.closest("[data-no-zoom]")) return false;
          }
          return !event.button;
        })
        .on("zoom", (event) => {
          if (zoomGroupRef.current) {
            d3.select(zoomGroupRef.current).attr(
              "transform",
              event.transform.toString(),
            );
          }
        });

      svg.call(zoomBehavior);
      svg.on("dblclick.zoom", null);
      zoomBehaviorRef.current = zoomBehavior;

      const sim = d3
        .forceSimulation<GraphNode>([])
        .force(
          "link",
          d3
            .forceLink<GraphNode, GraphLink>([])
            .id((d) => d.id)
            .distance(200),
        )
        .force("charge", d3.forceManyBody<GraphNode>().strength(-400))
        .force(
          "center",
          d3.forceCenter(dimsRef.current.width / 2, dimsRef.current.height / 2),
        )
        .force("collision", d3.forceCollide<GraphNode>().radius(50));

      sim.on("tick", () => {
        if (!linksGroupRef.current || !nodesGroupRef.current) return;
        d3.select(linksGroupRef.current)
          .selectAll<SVGPathElement, GraphLink>("path.edge-line, path.edge-hit")
          .attr("d", (d) => linkArc(d));
        d3.select(nodesGroupRef.current)
          .selectAll<SVGGElement, GraphNode>("g.node")
          .attr("transform", (d) => `translate(${d.x ?? 0},${d.y ?? 0})`);
      });

      simRef.current = sim;

      // Click on bare SVG → deselect peer
      svg.on("click", (event) => {
        if (event.target === svgRef.current) {
          callbacksRef.current.onPeerClick(null);
        }
      });

      return () => {
        sim.stop();
        svg.on(".zoom", null);
        svg.on("click", null);
      };
    }, []);

    // ── Re-center on resize ─────────────────────────────────────────────────
    useEffect(() => {
      const sim = simRef.current;
      if (!sim) return;
      sim.force("center", d3.forceCenter(dims.width / 2, dims.height / 2));
      const broker = nodesByIdRef.current.get("broker");
      if (broker) {
        broker.fx = dims.width / 2;
        broker.fy = dims.height / 2;
      }
      sim.alpha(0.3).restart();
    }, [dims.width, dims.height]);

    // ── Sync nodes/links from peers prop ────────────────────────────────────
    useEffect(() => {
      const sim = simRef.current;
      if (!sim) return;

      const cx = dimsRef.current.width / 2;
      const cy = dimsRef.current.height / 2;
      const oldNodes = nodesByIdRef.current;
      const newNodes = new Map<string, GraphNode>();

      // Broker node — always pinned to center
      const brokerNode: GraphNode = oldNodes.get("broker") ?? {
        id: "broker",
        type: "broker",
        label: "BROKER",
        full_id: brokerId,
        subscriptions: [],
        x: cx,
        y: cy,
      };
      brokerNode.fx = cx;
      brokerNode.fy = cy;
      brokerNode.full_id = brokerId;
      newNodes.set("broker", brokerNode);

      // Peer nodes — preserve positions for existing peers
      const peerArr = Array.from(peers.values());
      const radius = Math.min(dimsRef.current.width, dimsRef.current.height) * 0.32;
      peerArr.forEach((peer, i) => {
        const existing = oldNodes.get(peer.peer_id);
        const angle = (i / Math.max(peerArr.length, 1)) * Math.PI * 2 - Math.PI / 2;
        const node: GraphNode =
          existing ??
          {
            id: peer.peer_id,
            type: "peer",
            label: peer.peer_id.slice(0, 6),
            full_id: peer.peer_id,
            subscriptions: peer.subscriptions,
            connected_at: peer.connected_at,
            role: peer.role,
            x: cx + Math.cos(angle) * radius,
            y: cy + Math.sin(angle) * radius,
          };
        node.subscriptions = peer.subscriptions;
        node.connected_at = peer.connected_at;
        node.role = peer.role;
        node.dying = peer.dying;
        newNodes.set(peer.peer_id, node);
      });
      nodesByIdRef.current = newNodes;

      // Build links
      const newLinks: GraphLink[] = [];
      const oldLinks = linksByIdRef.current;
      const newLinkMap = new Map<string, GraphLink>();
      for (const peer of peers.values()) {
        peer.subscriptions.forEach((topic, idx) => {
          const id = `${peer.peer_id}::${topic}`;
          const existing = oldLinks.get(id);
          const link: GraphLink =
            existing ??
            {
              id,
              source: peer.peer_id,
              target: "broker",
              topic,
              message_count: 0,
              bend_index: idx,
            };
          link.bend_index = idx;
          link.topic = topic;
          // Reset source/target to id strings so forceLink can resolve them
          // when starting; D3 will mutate them into node objects.
          if (typeof link.source !== "string" && (link.source as GraphNode).id) {
            link.source = (link.source as GraphNode).id;
          }
          if (typeof link.target !== "string" && (link.target as GraphNode).id) {
            link.target = (link.target as GraphNode).id;
          }
          newLinks.push(link);
          newLinkMap.set(id, link);
        });
      }
      linksByIdRef.current = newLinkMap;

      const allNodes = Array.from(newNodes.values());
      sim.nodes(allNodes);
      const linkForce = sim.force("link") as d3.ForceLink<GraphNode, GraphLink>;
      linkForce.links(newLinks);
      sim.alpha(0.7).restart();

      renderLinks(newLinks);
      renderNodes(allNodes);
    }, [peers, brokerId]);

    // ── Update attention (selection / hover dimming) ────────────────────────
    useEffect(() => {
      updateAttention();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedPeerId, hoveredPeer, hoveredEdge, peers]);

    // ── Pulse animation listener ────────────────────────────────────────────
    useEffect(() => {
      const handler = (e: Event) => {
        const ev = e as CustomEvent<PulseEventDetail>;
        const { topic, subscribers } = ev.detail;
        for (const peerId of subscribers) {
          spawnPulseForLink(`${peerId}::${topic}`, topic);
        }
      };
      window.addEventListener("quiver:pulse", handler);
      return () => window.removeEventListener("quiver:pulse", handler);
    }, []);

    // ── Imperative reset view ───────────────────────────────────────────────
    useImperativeHandle(ref, () => ({
      resetView() {
        const svg = svgRef.current;
        const zoom = zoomBehaviorRef.current;
        if (!svg || !zoom) return;
        d3.select(svg)
          .transition()
          .duration(400)
          .call(zoom.transform, d3.zoomIdentity);
        simRef.current?.alpha(0.5).restart();
      },
    }));

    // ── Render helpers ──────────────────────────────────────────────────────
    function linkArc(d: GraphLink): string {
      const source = d.source as GraphNode;
      const target = d.target as GraphNode;
      const sx = source?.x ?? 0;
      const sy = source?.y ?? 0;
      const tx = target?.x ?? 0;
      const ty = target?.y ?? 0;
      const dx = tx - sx;
      const dy = ty - sy;
      const subsLen = source?.subscriptions?.length ?? 1;
      const bend = 1.0 + d.bend_index * 0.18 + (subsLen > 1 ? 0.12 : 0);
      const dr = Math.sqrt(dx * dx + dy * dy) * bend;
      return `M${sx},${sy}A${dr},${dr} 0 0,1 ${tx},${ty}`;
    }

    function renderLinks(links: GraphLink[]) {
      if (!linksGroupRef.current) return;
      const g = d3.select(linksGroupRef.current);
      const groups = g
        .selectAll<SVGGElement, GraphLink>("g.link")
        .data(links, (d) => d.id);

      const enter = groups.enter().append("g").attr("class", "link");

      enter
        .append("path")
        .attr("class", "edge-line")
        .attr("fill", "none")
        .attr("stroke-linecap", "round")
        .attr("data-no-zoom", "true");

      enter
        .append("path")
        .attr("class", "edge-hit")
        .attr("fill", "none")
        .attr("stroke", "transparent")
        .attr("stroke-width", 14)
        .attr("data-no-zoom", "true")
        .style("cursor", "help")
        .on("mouseenter", function (_evt, d) {
          setHoveredEdge(d.id);
        })
        .on("mouseleave", () => setHoveredEdge(null));

      groups.exit().remove();

      const merged = enter.merge(groups);

      merged
        .select<SVGPathElement>("path.edge-line")
        .attr("stroke", (d) => colorForRef.current(d.topic))
        .attr("marker-end", (d) => {
          const c = colorForRef.current(d.topic);
          return `url(#qg-arrow-${c.replace("#", "")})`;
        });
    }

    function renderNodes(nodes: GraphNode[]) {
      if (!nodesGroupRef.current) return;
      const g = d3.select(nodesGroupRef.current);
      const peerNodes = nodes.filter((n) => n.type === "peer");
      const groups = g
        .selectAll<SVGGElement, GraphNode>("g.node")
        .data(peerNodes, (d) => d.id);

      const enter = groups
        .enter()
        .append("g")
        .attr("class", "node")
        .attr("data-no-zoom", "true")
        .style("cursor", "pointer")
        .style("transition", "opacity 200ms");

      enter
        .append("circle")
        .attr("class", "node-circle")
        .attr("r", 20)
        .attr("fill", COLORS.peerFill)
        .attr("stroke", COLORS.peerStroke)
        .attr("stroke-width", 1.5);

      enter
        .append("text")
        .attr("class", "node-id")
        .attr("text-anchor", "middle")
        .attr("y", 4)
        .attr("font-family", "'JetBrains Mono', monospace")
        .attr("font-size", 9)
        .attr("font-weight", 600)
        .attr("fill", COLORS.textPrim);

      enter
        .append("text")
        .attr("class", "node-role")
        .attr("text-anchor", "middle")
        .attr("y", 36)
        .attr("font-family", "Inter, sans-serif")
        .attr("font-size", 10)
        .attr("fill", COLORS.textSec);

      // Drag — only for peers, and only when sim is up
      const drag = d3
        .drag<SVGGElement, GraphNode>()
        .on("start", (event, d) => {
          if (!event.active) simRef.current?.alphaTarget(0.3).restart();
          d.fx = d.x;
          d.fy = d.y;
        })
        .on("drag", (event, d) => {
          d.fx = event.x;
          d.fy = event.y;
        })
        .on("end", (event, d) => {
          if (!event.active) simRef.current?.alphaTarget(0);
          d.fx = null;
          d.fy = null;
        });

      enter.call(drag);

      enter
        .on("mouseenter", function (_evt, d) {
          setHoveredPeer(d.id);
        })
        .on("mouseleave", () => setHoveredPeer(null))
        .on("click", function (event, d) {
          event.stopPropagation();
          const cur = callbacksRef.current.selectedPeerId;
          callbacksRef.current.onPeerClick(cur === d.id ? null : d.id);
        });

      groups.exit().remove();

      const merged = enter.merge(groups);
      merged
        .classed("peer-dying", (d) => !!d.dying)
        .select<SVGCircleElement>("circle.node-circle")
        .attr("stroke", (d) =>
          d.dying ? COLORS.peerStrokeDying : COLORS.peerStroke,
        );

      merged.select<SVGTextElement>("text.node-id").text((d) => d.id.slice(0, 6));
      merged
        .select<SVGTextElement>("text.node-role")
        .text((d) => d.role ?? "peer");
    }

    function updateAttention() {
      if (linksGroupRef.current) {
        d3.select(linksGroupRef.current)
          .selectAll<SVGGElement, GraphLink>("g.link")
          .attr("opacity", (d) => {
            const peerId =
              typeof d.source === "string"
                ? d.source
                : (d.source as GraphNode).id;
            const dimSel = selectedPeerId && peerId !== selectedPeerId;
            const dimHov = hoveredPeer && peerId !== hoveredPeer;
            return dimSel || dimHov ? 0.18 : 1;
          })
          .selectAll<SVGPathElement, GraphLink>("path.edge-line")
          .attr("stroke-opacity", (d) => (hoveredEdge === d.id ? 1 : 0.55))
          .attr("stroke-width", (d) => (hoveredEdge === d.id ? 3 : 1.6));
      }

      if (nodesGroupRef.current) {
        d3.select(nodesGroupRef.current)
          .selectAll<SVGGElement, GraphNode>("g.node")
          .attr("opacity", (d) => {
            if (d.dying) return 0.45;
            if (selectedPeerId && d.id !== selectedPeerId) return 0.25;
            return 1;
          });
        d3.select(nodesGroupRef.current)
          .selectAll<SVGGElement, GraphNode>("g.node")
          .select<SVGCircleElement>("circle.node-circle")
          .attr("stroke", (d) => {
            if (d.dying) return COLORS.peerStrokeDying;
            if (hoveredPeer === d.id || selectedPeerId === d.id)
              return COLORS.peerStrokeHover;
            return COLORS.peerStroke;
          })
          .attr("stroke-width", (d) =>
            selectedPeerId === d.id ? 2 : 1.5,
          );
      }
    }

    function spawnPulseForLink(linkId: string, topic: string) {
      const linksG = linksGroupRef.current;
      const pulsesG = pulsesGroupRef.current;
      if (!linksG || !pulsesG) return;

      const matching = d3
        .select(linksG)
        .selectAll<SVGGElement, GraphLink>("g.link")
        .filter((d) => d.id === linkId);

      const pathEl = matching.select<SVGPathElement>("path.edge-line").node();
      if (!pathEl) return;

      const color = colorForRef.current(topic);
      const circle = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "circle",
      );
      circle.setAttribute("r", "3");
      circle.setAttribute("fill", color);
      circle.setAttribute("filter", `drop-shadow(0 0 6px ${color})`);
      circle.setAttribute("opacity", "0");
      circle.setAttribute("pointer-events", "none");
      pulsesG.appendChild(circle);

      const start = performance.now();

      const animate = () => {
        if (!pathEl.isConnected) {
          circle.remove();
          return;
        }
        const t = Math.min((performance.now() - start) / PULSE_DURATION, 1);
        const eased = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
        let totalLength = 0;
        try {
          totalLength = pathEl.getTotalLength();
        } catch {
          circle.remove();
          return;
        }
        // path is drawn peer→broker; pulse travels broker→peer (reverse traversal)
        const lengthAt = (1 - eased) * totalLength;
        try {
          const point = pathEl.getPointAtLength(lengthAt);
          circle.setAttribute("cx", String(point.x));
          circle.setAttribute("cy", String(point.y));
        } catch {
          circle.remove();
          return;
        }
        let opacity = 1;
        if (t < 0.1) opacity = t * 10;
        else if (t > 0.85) opacity = (1 - t) / 0.15;
        circle.setAttribute(
          "opacity",
          String(Math.max(0, Math.min(1, opacity))),
        );
        const r = t < 0.5 ? 2.5 + t * 5 : 5 - (t - 0.5) * 5;
        circle.setAttribute("r", String(Math.max(2, r)));
        if (t < 1) {
          requestAnimationFrame(animate);
        } else {
          circle.remove();
        }
      };
      requestAnimationFrame(animate);
    }

    // ── Topic colors → marker defs ──────────────────────────────────────────
    const arrowMarkerColors = useMemo(() => {
      const set = new Set<string>();
      for (const peer of peers.values()) {
        for (const t of peer.subscriptions) set.add(colorFor(t));
      }
      return Array.from(set);
    }, [peers, colorFor]);

    const cx = dims.width / 2;
    const cy = dims.height / 2;
    const ringFactor = [0.18, 0.32, 0.46];
    const livePeers = Array.from(peers.values()).filter((p) => !p.dying);
    const isEmpty = livePeers.length === 0;

    const hoveredPeerObj = hoveredPeer ? peers.get(hoveredPeer) : null;
    const hoveredPeerNode = hoveredPeer
      ? nodesByIdRef.current.get(hoveredPeer)
      : null;
    const hoveredLink = hoveredEdge ? linksByIdRef.current.get(hoveredEdge) : null;

    return (
      <div
        ref={containerRef}
        style={{
          position: "relative",
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          background: COLORS.bgPrimary,
          overflow: "hidden",
        }}
      >
        <svg
          ref={svgRef}
          width={dims.width}
          height={dims.height}
          style={{ display: "block", background: COLORS.bgPrimary }}
        >
          <defs>
            <pattern
              id="qg-grid"
              width="40"
              height="40"
              patternUnits="userSpaceOnUse"
            >
              <circle cx="0.5" cy="0.5" r="0.7" fill="rgba(148,163,184,0.18)" />
            </pattern>
            <radialGradient id="qg-vignette" cx="50%" cy="50%" r="60%">
              <stop offset="0%" stopColor="#1e1b4b" stopOpacity="0.28" />
              <stop offset="60%" stopColor="#0b1220" stopOpacity="0" />
              <stop offset="100%" stopColor="#000" stopOpacity="0.55" />
            </radialGradient>
            <radialGradient id="qg-broker-glow" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#a5b4fc" stopOpacity="0.55" />
              <stop offset="60%" stopColor="#6366f1" stopOpacity="0.18" />
              <stop offset="100%" stopColor="#6366f1" stopOpacity="0" />
            </radialGradient>
            {arrowMarkerColors.map((color) => (
              <marker
                key={color}
                id={`qg-arrow-${color.replace("#", "")}`}
                viewBox="0 -4 8 8"
                refX="6"
                refY="0"
                markerWidth="6"
                markerHeight="6"
                orient="auto"
              >
                <path d="M0,-4L8,0L0,4Z" fill={color} />
              </marker>
            ))}
          </defs>

          <rect width={dims.width} height={dims.height} fill="url(#qg-grid)" />
          <rect
            width={dims.width}
            height={dims.height}
            fill="url(#qg-vignette)"
          />

          <g ref={zoomGroupRef}>
            {/* concentric dashed rings */}
            {ringFactor.map((f, i) => (
              <circle
                key={i}
                cx={cx}
                cy={cy}
                r={Math.min(dims.width, dims.height) * f}
                fill="none"
                stroke="rgba(99,102,241,0.10)"
                strokeDasharray="2 4"
              />
            ))}

            {/* broker glow halo */}
            <circle cx={cx} cy={cy} r={140} fill="url(#qg-broker-glow)">
              <animate
                attributeName="r"
                values="120;160;120"
                dur="3s"
                repeatCount="indefinite"
              />
              <animate
                attributeName="opacity"
                values="0.7;1;0.7"
                dur="3s"
                repeatCount="indefinite"
              />
            </circle>

            {/* D3-managed groups (do not put React children here) */}
            <g ref={linksGroupRef} />
            <g ref={pulsesGroupRef} />
            <g ref={nodesGroupRef} />

            {/* broker node — rendered last so it draws over edges/pulses */}
            <g
              transform={`translate(${cx},${cy})`}
              pointerEvents="none"
              className="broker-glow"
            >
              <circle
                r={34}
                fill={COLORS.brokerFill}
                stroke={COLORS.brokerStroke}
                strokeWidth="1.5"
              >
                <animate
                  attributeName="r"
                  values="33;36;33"
                  dur="2s"
                  repeatCount="indefinite"
                />
              </circle>
              <circle r={28} fill="none" stroke="rgba(255,255,255,0.18)" />
              <g
                stroke="#fff"
                strokeWidth="1.6"
                fill="none"
                strokeLinecap="round"
              >
                <path d="M -10 -2 L 0 -10 L 10 -2 L 0 8 Z" />
                <path d="M 0 -10 L 0 8" opacity="0.6" />
              </g>
              <text
                textAnchor="middle"
                y={52}
                fontFamily="Inter, sans-serif"
                fontSize={11}
                fontWeight={700}
                fill={COLORS.textPrim}
                letterSpacing="0.12em"
              >
                BROKER
              </text>
              <text
                textAnchor="middle"
                y={66}
                fontFamily="'JetBrains Mono', monospace"
                fontSize={9}
                fill={COLORS.textSec}
              >
                {brokerId
                  ? brokerId.slice(0, 12) + (brokerId.length > 12 ? "…" : "")
                  : "—"}
              </text>
            </g>

            {/* hovered peer tooltip */}
            {hoveredPeerObj && hoveredPeerNode && (
              <g
                transform={`translate(${(hoveredPeerNode.x ?? 0) + 28},${
                  (hoveredPeerNode.y ?? 0) - 36
                })`}
                pointerEvents="none"
              >
                <rect
                  x={0}
                  y={0}
                  rx={6}
                  ry={6}
                  width={220}
                  height={62}
                  fill="#0f172a"
                  stroke="#334155"
                />
                <text
                  x={10}
                  y={18}
                  fontFamily="'JetBrains Mono', monospace"
                  fontSize={10}
                  fill={COLORS.textPrim}
                >
                  {hoveredPeerObj.peer_id.slice(0, 24)}…
                </text>
                <text
                  x={10}
                  y={34}
                  fontFamily="Inter, sans-serif"
                  fontSize={10}
                  fill={COLORS.textSec}
                >
                  role · {hoveredPeerObj.role ?? "peer"}
                </text>
                <text
                  x={10}
                  y={50}
                  fontFamily="Inter, sans-serif"
                  fontSize={10}
                  fill={COLORS.textSec}
                >
                  subs · {hoveredPeerObj.subscriptions.join(", ") || "—"}
                </text>
              </g>
            )}

            {/* hovered edge tooltip */}
            {hoveredLink && (() => {
              const source = hoveredLink.source as GraphNode;
              const target = hoveredLink.target as GraphNode;
              const mx = ((source?.x ?? 0) + (target?.x ?? 0)) / 2;
              const my = ((source?.y ?? 0) + (target?.y ?? 0)) / 2;
              const color = colorFor(hoveredLink.topic);
              return (
                <g
                  transform={`translate(${mx + 8},${my - 22})`}
                  pointerEvents="none"
                >
                  <rect
                    rx={4}
                    ry={4}
                    width={120}
                    height={32}
                    fill="#0f172a"
                    stroke={color}
                  />
                  <circle cx={10} cy={16} r={4} fill={color} />
                  <text
                    x={20}
                    y={14}
                    fontFamily="Inter,sans-serif"
                    fontSize={10}
                    fill={COLORS.textPrim}
                    fontWeight={600}
                  >
                    {hoveredLink.topic}
                  </text>
                  <text
                    x={20}
                    y={26}
                    fontFamily="Inter,sans-serif"
                    fontSize={9}
                    fill={COLORS.textSec}
                  >
                    subscription
                  </text>
                </g>
              );
            })()}
          </g>
        </svg>

        {isEmpty && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              pointerEvents: "none",
              color: COLORS.textSec,
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 12,
              textAlign: "center",
              padding: 20,
            }}
          >
            <div>
              Waiting for peers to connect…
              <br />
              <span style={{ opacity: 0.7 }}>
                Run: python run_client.py sub &lt;topic&gt;
              </span>
            </div>
          </div>
        )}
      </div>
    );
  },
);
