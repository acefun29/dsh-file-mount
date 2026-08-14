/** CSS-module import typing (the client bundle inlines hashed class maps). */
declare module '*.module.css' {
  const classes: { readonly [key: string]: string }
  export default classes
}
