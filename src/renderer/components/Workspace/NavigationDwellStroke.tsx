import React from 'react';
import {TAB_DRAG_NAVIGATION_DWELL_MS,NAVIGATION_DWELL_COLOR,NAVIGATION_DWELL_TRACK} from '../../utils/navigationDwell.mjs';

/** Same finite stroke clock as workflow hover, without per-frame React writes.
 * SVG rect starts along its top edge and travels clockwise. */
export default function NavigationDwellStroke({shape='circle',length=100,attributes={},trackFill='none'}:{
  shape?:'circle'|'rect';length?:number;attributes?:Record<string,string|number>;trackFill?:string;
}) {
  const Shape=shape;
  return <>
    <Shape {...attributes} fill={trackFill} stroke={NAVIGATION_DWELL_TRACK} strokeWidth="2"/>
    <Shape {...attributes} fill="none" stroke={NAVIGATION_DWELL_COLOR} strokeWidth="2.2" strokeLinecap="round"
      strokeDasharray={length} strokeDashoffset={length}>
      <animate attributeName="stroke-dashoffset" from={length} to="0" dur={`${TAB_DRAG_NAVIGATION_DWELL_MS}ms`} fill="freeze"/>
    </Shape>
  </>;
}
