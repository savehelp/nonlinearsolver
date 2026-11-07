# MOSFET DC channel model

PSpice selects **Shichman–Hodges** with `LEVEL=1`; its other levels select different models. The bundled [NMOSFET](../elements/nmosfet.json) and [PMOSFET](../elements/pmosfet.json) definitions use its square-law channel current and body-dependent threshold, with the requested length-dependent lambda correction. They do not reproduce every PSpice device feature. [Cadence PSpice Reference Guide, pp. 174, 197–198](https://e2e.ti.com/cfs-file/__key/communityserver-discussions-components-files/234/PSpice_5F00_ReferenceguideOrCAD.pdf)

## Bundled defaults

The models use the supplied NFET4 and PFET4 large-signal process values. PFET3 is not a separate bundled type. Device width and length were not in the cards; both start at `W = 1u`, `L = .5u`.

| Input | NMOSFET / NFET4 | PMOSFET / PFET4 | Unit |
| --- | ---: | ---: | --- |
| `VTO` | 0.7 | −0.8 | V |
| `GAMMA` | 0.45 | 0.4 | √V |
| `PHI` | 0.9 | 0.8 | V |
| `W` | 1e−6 | 1e−6 | m |
| `L` | 0.5e−6 | 0.5e−6 | m |
| `LD` | 0.08e−6 | 0.09e−6 | m |
| `UO` | 350 | 100 | cm²/(V·s) |
| `TOX` | 9e−9 | 9e−9 | m |
| `CLM_C` | 0.034e−6 | 0.064e−6 | m/V |

Override these with ordinary instance parameters, such as `parameter M1.VTO .65` or `parameter M1.W 2u`. `Leff`, `Cox`, `KP`, `K`, `VTH`, and `LAMBDA` are derived members, not parameter inputs. At the default geometry, NMOS `Leff = .34u`, `LAMBDA = .1`; PMOS `Leff = .32u`, `LAMBDA = .2`.

## Voltages and body effect

Use polarity \(p=+1\) for NMOS and \(p=-1\) for PMOS. The external drain and source connections retain their names \(d,s\). Their wiring stays fixed while the equations select active-source voltage \(q\) and active-drain voltage \(r\) from their potentials:

\[
q=\begin{cases}\min(d,s),&p=+1,\\\max(d,s),&p=-1,\end{cases}
\qquad
r=\begin{cases}\max(d,s),&p=+1,\\\min(d,s),&p=-1.\end{cases}
\]

The channel equations then use normalized coordinates

\[
v_{GS}=p(g-q),\qquad v_{DS}=|d-s|,\qquad v_{SB}=p(q-b).
\]

These are the `channel_vgs`, `channel_vds`, and `channel_vsb` members. The channel-voltage magnitude is nonnegative in either direction. For reverse-biased body junctions, \(v_{SB}\ge0\), the normalized threshold is

\[
v_T=p\,VTO+GAMMA\left(\sqrt{PHI+v_{SB}}-\sqrt{PHI}\right).
\]

`VTO` is signed: positive for enhancement NMOS, negative for enhancement PMOS. `PHI` already denotes \(2|\phi_F|\); do not double it again. Increasing reverse body bias increases threshold magnitude. [Cadence guide, pp. 176, 197–198](https://e2e.ti.com/cfs-file/__key/communityserver-discussions-components-files/234/PSpice_5F00_ReferenceguideOrCAD.pdf)

JSON members `vgs = g-s`, `vds = d-s`, and `vsb = s-b` retain their fixed-pin signs. Computed `VTH` is the signed threshold \(p v_T\); `source_voltage` and `drain_voltage` expose \(q,r\). Accepted operating points require `b <= min(d,s)` for NMOS and `b >= max(d,s)` for PMOS. Thus reversing the conduction pins changes the channel's source reference, including body effect, without changing the external connections. This follows the PSpice Level 1 instruction to swap source and drain in inverted operation. [Cadence guide, p. 198](https://e2e.ti.com/cfs-file/__key/communityserver-discussions-components-files/234/PSpice_5F00_ReferenceguideOrCAD.pdf)

Newton trial values can temporarily forward-bias the body. To avoid invalid square roots during those trials, define \(x=p(q-b)\) and evaluate the body root as

\[
S(x)=\begin{cases}
\sqrt{PHI+x},&x\ge0,\\
\max\left(0,\sqrt{PHI}+x/(2\sqrt{PHI})\right),&x<0.
\end{cases}
\]

The threshold uses `S(x)` in place of the first square root. This tangent continuation follows Berkeley/ngspice MOS1; it is a numerical aid, not a claim that PSpice has identical internal handling. The model's validity checks still reject forward-body-biased roots. [Berkeley/ngspice MOS1 body calculation](https://raw.githubusercontent.com/ngspice/ngspice/master/src/spicelib/devices/mos1/mos1load.c)

## Geometry and units

Use metres for `W`, `L`, `LD`, and `TOX`. Nominal process conversion is

\[
L_{eff}=L-2LD,\quad
C_{ox}=\frac{3.9\epsilon_0}{TOX},\quad
K_P=(UO\times10^{-4})C_{ox},\quad
\beta=K_P\frac{W}{L_{eff}}.
\]

`UO` uses the SPICE convention cm²/(V·s); the factor converts it to m²/(V·s). `KP` has units A/V². Explicit `GAMMA` and `PHI` take precedence over values derived from substrate doping; retaining them means `NSUB` does not independently alter this threshold equation. [Berkeley/ngspice MOS1 process initialization](https://raw.githubusercontent.com/ngspice/ngspice/master/src/spicelib/devices/mos1/mos1temp.c)

The requested correction is

\[
\lambda=\frac{C_\lambda}{L_{eff}},\qquad
C_{\lambda,N}=0.034\times10^{-6}\ \mathrm{m/V},\quad
C_{\lambda,P}=0.064\times10^{-6}\ \mathrm{m/V}.
\]

These coefficients come from the supplied model correction and are stored as `CLM_C`. This relationship replaces a fixed `LAMBDA`; it is not an automatic PSpice Level 1 scaling rule. Geometry must satisfy `W > 0`, `L > 2*LD`, and `TOX > 0`; `PHI` must be positive. The model's computed `K` is \(\beta\), using \(\epsilon_0=8.854214871\times10^{-12}\,F/m\).

## Current and the region boundary

Let \(u=v_{GS}-v_T\). Channel current magnitude is

\[
I_{ch}=\begin{cases}
0,&u\le0,\\
\beta(uv_{DS}-v_{DS}^2/2)(1+\lambda v_{DS}),&0\le v_{DS}<u,\\
\beta u^2(1+\lambda v_{DS})/2,&v_{DS}\ge u.
\end{cases}
\]

Current `id` keeps a fixed reference from the named external drain `d` toward the named external source `s`:

\[
i_d=\begin{cases}I_{ch},&d\ge s,\\-I_{ch},&d<s.\end{cases}
\]

At equal terminal voltages the current is zero. In NMOS operation, `d > s` produces positive channel current and `s > d` produces negative channel current when the channel is on. Normal PMOS operation has `s > d` and negative `id`; inverted PMOS operation has `d > s` and positive `id`. A negative drain current therefore means conventional current flows from named source toward named drain; it does not universally mean inverted operation or identify the bias of a body junction. Both conducting regions use the same modulation factor, as in PSpice Level 1. [Cadence guide, p. 198](https://e2e.ti.com/cfs-file/__key/communityserver-discussions-components-files/234/PSpice_5F00_ReferenceguideOrCAD.pdf)

For KCL with currents leaving each node, the device contributes `+M1.id` at its drain node and `-M1.id` at its source node. These references remain fixed when the internal source/drain roles swap.

Substitution at \(v_{DS}=u\) gives \(I_{ch}=\beta u^2(1+\lambda u)/2\) on both sides. Differentiation gives the same drain-voltage slope, \(\beta\lambda u^2/2\), and the same gate-overdrive slope. Thus current and first derivatives agree; second derivatives can differ. A smoothing blend is unnecessary for boundary continuity.

The signed current and its first voltage derivatives also match when the conduction-terminal voltages cross. Near \(d=s\), with local overdrive \(u_0\),

\[
i_d=\beta\max(u_0,0)(d-s)+O((d-s)^2).
\]

Both sides therefore have the same small drain-to-source conductance. At threshold, the leading term is quadratic and the first slopes approach zero. Source selection through `min`/`max` can give `source_voltage` and `VTH` a change in slope at the crossing; continuity of the physical channel current does not mean every helper member has continuous derivatives. Current is generally not twice continuously differentiable at region boundaries.

## Body terminal in element JSON

An optional source-tied body is represented by

```json
{
  "terminals": ["g", "d", "s", "b"],
  "terminalDefaults": { "b": "s" }
}
```

Use `M1.g`, `M1.d`, `M1.s`, and `M1.b` for the external connections. Earlier `t1`/`t2` aliases remain supported for existing workspaces, but the model interface and examples use `d`/`s`.

For an active instance, the fallback adds `M1.b = M1.s` unless `M1.b` appears in an external mathematical equation. This ties body to the fixed named source pin, not to the dynamically selected source. An explicit connection such as `M1.b = 0;` suppresses that fallback. Plotting the body, adding a validity check, or supplying an initial guess does not connect it. Gate, drain, and source still require circuit equations.

For a bidirectional NMOS, connect body at or below both conduction pins; for PMOS, connect it at or above both. A body left tied to the named source can become forward biased after a voltage reversal, which this channel-only model rejects. Moving the default body connection when the selected source changes would alter the circuit, so the fallback stays attached to its original external pin.

Both types require real solver mode. For a PMOS with its s pin at `Vdd` and a resistor from d to ground, use `M1.s = Vdd; M1.d = -M1.id*R1;`; plotting `-M1.id*1000` shows positive supply-current magnitude in milliamps. The **MOS elements · bidirectional channel** example uses `d`/`s` connections and explicit bodies for both types while their terminal voltages cross.

Saved workspaces retain their embedded definitions. To adopt a newer bundled model, restore that type's default under **Settings → Elements**. When switching from the older NMOS definition, replace parameter overrides for `VTH`, `K`, and `LAMBDA` with inputs such as `VTO`, `W`, and `CLM_C`.

This is a static channel-current model. Capacitance, charge storage, temperature variation, subthreshold conduction, and body-diode currents are outside its scope. Body-diode leakage is a DC effect in full PSpice, so omitting it is an approximation even in large-signal DC analysis. [Cadence guide, p. 198](https://e2e.ti.com/cfs-file/__key/communityserver-discussions-components-files/234/PSpice_5F00_ReferenceguideOrCAD.pdf)
