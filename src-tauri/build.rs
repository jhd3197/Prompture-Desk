fn main() {
    // The icons are compiled into the executable (and the window icon into the
    // crate), so a new icon set must trigger a rebuild even when no code changed.
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
