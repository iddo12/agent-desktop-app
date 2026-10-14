## v1.119.5 - Fix: the Systems grid dropped to one column on small screens (my 1.119.4 side effect)

UI/UX measured 1.119.4 on 1280x720 / 1366x768: the sidebar scrollbar (15 px) narrowed the Systems grid from 256 to 241 px, below the 242 px that two 118 px columns need, so the grid became ONE column (553 px tall) and pushed the agent list off the screen. Now the columns are min 100 px (two fit with a scrollbar) and the sidebar scrollbar is thin. The bigger redesign (gear popover, notices badge, icon strip) still waits for the owner's OK.
