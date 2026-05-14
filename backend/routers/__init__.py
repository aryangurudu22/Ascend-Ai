# ============================================================
# ASCENDAI BACKEND — routers package marker
# ============================================================
# This empty file tells Python that the `routers` directory is a
# package, which means we can write `from routers import homework`
# in main.py instead of having to import a single big file.
#
# Why a package per feature?
# Because the original main.py grew to >500 lines as the Homework
# Assistant evolved. Splitting each feature into its own router
# file keeps main.py small (it only wires routers together) and
# makes it obvious where every endpoint lives. New features will
# follow the same pattern — e.g. routers/notes.py, routers/timetable.py.
# ============================================================
