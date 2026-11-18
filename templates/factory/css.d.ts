// Next's shipped types only declare '*.module.css'; plain global stylesheets
// need this for `tsc --noEmit` to accept the side-effect import in app/layout.tsx.
declare module "*.css";
