import { Basis, safe_unit, tangent } from "./common.wgsl";
export fn smooth_kind(kind:f32)->bool {return kind==8.0 || kind==9.0 || kind==11.0;}
fn field_header(config:ptr<storage,array<vec4f>,read>)->u32 {return u32((*config)[16u+2u*u32((*config)[9].y)].w);}
export struct SmoothSurface {position:vec3f,u:vec3f,v:vec3f,normal:vec3f}
struct CanonicalUV {point:vec2f,parity:f32}
fn canonical(config:ptr<storage,array<vec4f>,read>,uv:vec2f)->CanonicalUV {
 let kind=(*config)[0].z;let turns=floor(uv.x);var parity=1.0;
 if(kind!=11.0 && (u32(abs(turns))&1u)==1u){parity=-1.0;}
 var v=uv.y;if(parity<0.0){v=select(-v,1.0-v,kind==8.0);}
 v=select(fract(v),clamp(v,0.0,1.0),kind==8.0);
 return CanonicalUV(vec2f(fract(uv.x),v),parity);
}
// Worker-precomputed coefficients of the same C1 tensor-Hermite patches.
// Unrolled Horner evaluation shares all16 loads across position and derivatives.
export fn smooth_topology(config:ptr<storage,array<vec4f>,read>,uv:vec2f)->SmoothSurface {
 let header=field_header(config);let dims=(*config)[header].xy;let c=canonical(config,uv);
 let grid=min(c.point*dims,dims-vec2f(0.00001));let cell=vec2u(floor(grid));let t=fract(grid);
 let row=header+1u+16u*(cell.x+u32(dims.x)*cell.y);
 let a0=(*config)[row].xyz;let b0=(*config)[row+1u].xyz;let c0=(*config)[row+2u].xyz;let d0=(*config)[row+3u].xyz;
 let a1=(*config)[row+4u].xyz;let b1=(*config)[row+5u].xyz;let c1=(*config)[row+6u].xyz;let d1=(*config)[row+7u].xyz;
 let a2=(*config)[row+8u].xyz;let b2=(*config)[row+9u].xyz;let c2=(*config)[row+10u].xyz;let d2=(*config)[row+11u].xyz;
 let a3=(*config)[row+12u].xyz;let b3=(*config)[row+13u].xyz;let c3=(*config)[row+14u].xyz;let d3=(*config)[row+15u].xyz;
 let p0=((d0*t.x+c0)*t.x+b0)*t.x+a0;let p1=((d1*t.x+c1)*t.x+b1)*t.x+a1;
 let p2=((d2*t.x+c2)*t.x+b2)*t.x+a2;let p3=((d3*t.x+c3)*t.x+b3)*t.x+a3;
 let u0=(3.0*d0*t.x+2.0*c0)*t.x+b0;let u1=(3.0*d1*t.x+2.0*c1)*t.x+b1;
 let u2=(3.0*d2*t.x+2.0*c2)*t.x+b2;let u3=(3.0*d3*t.x+2.0*c3)*t.x+b3;
 let position=((p3*t.y+p2)*t.y+p1)*t.y+p0;
 let u=(((u3*t.y+u2)*t.y+u1)*t.y+u0)*dims.x;
 let v=((3.0*p3*t.y+2.0*p2)*t.y+p1)*dims.y*c.parity;
 return SmoothSurface(position,u,v,safe_unit(cross(u,v)));
}
// Display normals have their own continuous four-node interpolation, avoiding
// full polynomial evaluation for every body/trail vertex.
export fn smooth_display_normal(config:ptr<storage,array<vec4f>,read>,uv:vec2f)->vec3f {
 let header=field_header(config);let dims=(*config)[header].xy;let c=canonical(config,uv);
 let grid=min(c.point*dims,dims-vec2f(0.00001));let cell=vec2u(floor(grid));let t=fract(grid);
 let row=header+u32((*config)[header].w)+cell.x+(u32(dims.x)+1u)*cell.y;
 let first=mix((*config)[row].xyz,(*config)[row+1u].xyz,t.x);
 let second=mix((*config)[row+u32(dims.x)+1u].xyz,(*config)[row+u32(dims.x)+2u].xyz,t.x);
 return safe_unit(mix(first,second,t.y))*c.parity;
}
export fn smooth_coordinates(surface:SmoothSurface,vector:vec3f)->vec2f {
 let E=dot(surface.u,surface.u);let F=dot(surface.u,surface.v);let G=dot(surface.v,surface.v);
 let a=dot(vector,surface.u);let b=dot(vector,surface.v);let determinant=max(E*G-F*F,1e-20);
 return vec2f(G*a-F*b,E*b-F*a)/determinant;
}
fn lifted(config:ptr<storage,array<vec4f>,read>,origin:vec2f,destinationUV:vec2f)->vec2f {
 let turns=round(origin.x-destinationUV.x);let flipped=(*config)[0].z!=11.0 && (u32(abs(turns))&1u)==1u;
 var v=destinationUV.y;if(flipped){v=select(-v,1.0-v,(*config)[0].z==8.0);}
 if((*config)[0].z!=8.0){v+=round(origin.y-v);}
 return vec2f(destinationUV.x+turns,v);
}
export fn smooth_normal_transport(vector:vec3f,originUV:vec3f,to:vec3f)->vec3f {
 let denominator=1.0+dot(originUV,to);if(denominator<1e-7){return tangent(vector,to);}
 return vector-(originUV+to)*(dot(vector,to)/denominator);
}
export struct SmoothRelation {displacement:vec3f,distance:f32,velocity:vec3f}
export fn smooth_relation(config:ptr<storage,array<vec4f>,read>,originUV:vec2f,origin:SmoothSurface,to:vec2f,velocity:vec3f)->SmoothRelation {
 let destination=lifted(config,originUV,to);let change=destination-originUV;
 let middle=smooth_topology(config,(originUV+destination)*0.5);let end=smooth_topology(config,destination);
 let initial=origin.u*change.x+origin.v*change.y;
 let midDirection=middle.u*change.x+middle.v*change.y;let endDirection=end.u*change.x+end.v*change.y;
 let distance=max((length(initial)+4.0*length(midDirection)+length(endDirection))/6.0,length(end.position-origin.position));
 let transported=smooth_normal_transport(smooth_normal_transport(velocity,end.normal,middle.normal),middle.normal,origin.normal);
 return SmoothRelation(safe_unit(initial)*distance,distance,transported);
}
export fn smooth_face_tag(config:ptr<storage,array<vec4f>,read>,uv:vec2f)->f32 {
 let dims=(*config)[field_header(config)].xy;let grid=min(canonical(config,uv).point*dims,dims-vec2f(0.00001));let cell=floor(grid);let t=fract(grid);
 return 1.0+2.0*(cell.x*dims.y+cell.y)+select(0.0,1.0,t.x+t.y>1.0);
}
export fn smooth_basis(surface:SmoothSurface,orientation:f32)->Basis {let n=surface.normal*select(-1.0,1.0,orientation>=0.0);let x=safe_unit(surface.u);return Basis(x,safe_unit(cross(n,x)),n);}
// UI/scene obstacles retain tagged mesh points. Their face-local chart is
// invertible without searching another immersed sheet at an intersection.
export fn smooth_tagged_chart(config:ptr<storage,array<vec4f>,read>,point:vec4f)->vec2f {
 let header=16u+2u*u32((*config)[9].y);let row=header+1u+u32(max(0.0,point.w-1.0))*8u;
 let a=(*config)[row].xyz;let e=(*config)[row+1u].xyz-a;let f=(*config)[row+2u].xyz-a;let d=point.xyz-a;
 let ee=dot(e,e);let ef=dot(e,f);let ff=dot(f,f);let det=max(ee*ff-ef*ef,1e-20);
 let y=(ff*dot(d,e)-ef*dot(d,f))/det;let z=(ee*dot(d,f)-ef*dot(d,e))/det;
 let chart=(*config)[row+7u];var uv=chart.xy*(1.0-y-z)+chart.zw*y+(*config)[row+6u].zw*z;
 return uv;
}
export fn smooth_point_chart(config:ptr<storage,array<vec4f>,read>,point:vec4f)->vec2f {
 var uv=smooth_tagged_chart(config,point);
 for(var step=0u;step<3u;step++){let s=smooth_topology(config,uv);uv+=smooth_coordinates(s,point.xyz-s.position);}
 return canonical(config,uv).point;
}
export struct SmoothMotion {position:vec3f,uv:vec2f,velocity:vec3f,previousVelocity:vec3f,orientation:f32}
export fn smooth_advance(config:ptr<storage,array<vec4f>,read>,uv:vec2f,orientation:f32,displacement:vec3f,velocity:vec3f,previous:vec3f)->SmoothMotion {
 let origin=smooth_topology(config,uv);let first=smooth_coordinates(origin,displacement);
 let middle=smooth_topology(config,uv+first*0.5);let middleMove=smooth_normal_transport(displacement,origin.normal,middle.normal);
 var endUV=uv+smooth_coordinates(middle,middleMove);var reflected=false;
 if((*config)[0].z==8.0 && (endUV.y<0.0 || endUV.y>1.0)){let t=endUV.y-2.0*floor(endUV.y*0.5);endUV.y=select(2.0-t,t,t<=1.0);reflected=true;}
 let end=smooth_topology(config,endUV);let normalized=canonical(config,endUV);
 var moving=smooth_normal_transport(smooth_normal_transport(velocity,origin.normal,middle.normal),middle.normal,end.normal);
 var old=smooth_normal_transport(smooth_normal_transport(previous,origin.normal,middle.normal),middle.normal,end.normal);
 if(reflected){let along=safe_unit(end.u);moving=along*2.0*dot(moving,along)-moving;}
 return SmoothMotion(end.position,normalized.point,moving,old,orientation*normalized.parity);
}
